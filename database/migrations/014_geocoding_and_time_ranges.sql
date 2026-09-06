-- ============================================================================
-- Migration 014 — coordinates and delivery time ranges
--
-- Prerequisite for real route optimization.
--
-- Until now an address was one opaque line of text: `orders.address
-- VARCHAR(500)`, typed by an employee. That is enough to hand a driver a
-- street to find, and not nearly enough to route: the FakeOptimizer standing
-- in for a real provider sorts stops by `address.localeCompare()`, which puts
-- "10 rue Notre-Dame" beside "100 boulevard Saint-Laurent" and calls it a
-- route.
--
-- Google Places gives us a standardized address, a stable place_id, and a
-- coordinate pair at the moment the employee picks a suggestion. Those go on
-- the row so that routing is a lookup, not a geocode: re-resolving addresses
-- at optimize time would bill per stop per run, and would drift as Google's
-- index changes underneath a delivery that already happened.
--
-- WHY THESE COLUMNS ARE NULLABLE
--
-- A rural or brand-new address that Google does not know must still be
-- deliverable. Every existing order also predates this migration. So a stop
-- without coordinates is normal, not broken — it is appended to the route in
-- its incoming order rather than dropped, and the driver still gets the text
-- address they have always had.
--
-- WHY clients GETS THEM TOO
--
-- The order's address is a snapshot taken at insert time and never
-- back-filled (see the base schema's comment on orders.patient_name). The
-- coordinates must be snapshotted the same way and for the same reason: a
-- patient who moves must not silently rewrite the route of a delivery that
-- already ran. Standardize once when the patient is saved, copy forward onto
-- each order.
--
-- WHY organizations GETS THEM
--
-- The Route Optimization API routes a vehicle, and a vehicle starts
-- somewhere. That somewhere is the pharmacy. Without a depot coordinate the
-- optimizer can only order stops relative to each other, which answers a
-- travelling-salesman question the driver did not ask.
--
-- PRIVACY
--
-- A coordinate pair is exactly as identifying as the address it came from —
-- more so, being machine-precise. It is treated as the same class of PII:
-- returned to a driver only while the delivery is active, absent from the
-- closed-order view, redacted from logs. See docs/privacy-rules.md.
--
-- TIME RANGES
--
-- `requested_delivery_time` (migration 011) is a single promised time. It
-- stays and keeps its meaning. What routing needs is an interval it can hand
-- the optimizer as a constraint, and what a pharmacy actually negotiates with
-- a patient is "between 2 and 4" more often than "at 2". Both nullable: most
-- deliveries only ever have their AM/PM window.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- ORDERS
-- ----------------------------------------------------------------------------

ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS place_id             VARCHAR(255),
    ADD COLUMN IF NOT EXISTS formatted_address    VARCHAR(500),
    ADD COLUMN IF NOT EXISTS latitude             DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS longitude            DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS geocoded_at          TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS requested_time_start TIME,
    ADD COLUMN IF NOT EXISTS requested_time_end   TIME;

-- ----------------------------------------------------------------------------
-- CLIENTS
-- ----------------------------------------------------------------------------

ALTER TABLE clients
    ADD COLUMN IF NOT EXISTS place_id          VARCHAR(255),
    ADD COLUMN IF NOT EXISTS formatted_address VARCHAR(500),
    ADD COLUMN IF NOT EXISTS latitude          DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS longitude         DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS geocoded_at       TIMESTAMPTZ;

-- ----------------------------------------------------------------------------
-- ORGANIZATIONS (the depot)
-- ----------------------------------------------------------------------------

ALTER TABLE organizations
    ADD COLUMN IF NOT EXISTS place_id          VARCHAR(255),
    ADD COLUMN IF NOT EXISTS formatted_address VARCHAR(500),
    ADD COLUMN IF NOT EXISTS latitude          DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS longitude         DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS geocoded_at       TIMESTAMPTZ;

-- ----------------------------------------------------------------------------
-- Coordinate integrity
--
-- Half a coordinate is worse than none: it reads as present to a naive check
-- and routes to the Gulf of Guinea. Both or neither, and both in range.
-- ----------------------------------------------------------------------------

ALTER TABLE orders DROP CONSTRAINT IF EXISTS chk_orders_coordinates_paired;
ALTER TABLE orders
    ADD CONSTRAINT chk_orders_coordinates_paired
    CHECK (
        (latitude IS NULL) = (longitude IS NULL)
        AND (latitude  IS NULL OR latitude  BETWEEN -90  AND 90)
        AND (longitude IS NULL OR longitude BETWEEN -180 AND 180)
    );

ALTER TABLE clients DROP CONSTRAINT IF EXISTS chk_clients_coordinates_paired;
ALTER TABLE clients
    ADD CONSTRAINT chk_clients_coordinates_paired
    CHECK (
        (latitude IS NULL) = (longitude IS NULL)
        AND (latitude  IS NULL OR latitude  BETWEEN -90  AND 90)
        AND (longitude IS NULL OR longitude BETWEEN -180 AND 180)
    );

ALTER TABLE organizations DROP CONSTRAINT IF EXISTS chk_organizations_coordinates_paired;
ALTER TABLE organizations
    ADD CONSTRAINT chk_organizations_coordinates_paired
    CHECK (
        (latitude IS NULL) = (longitude IS NULL)
        AND (latitude  IS NULL OR latitude  BETWEEN -90  AND 90)
        AND (longitude IS NULL OR longitude BETWEEN -180 AND 180)
    );

-- ----------------------------------------------------------------------------
-- Time range integrity
--
-- A range is both ends or neither — a lone start is an interval with no close,
-- which the optimizer reads as "any time after", and that is a different
-- promise than the one the pharmacy made. Same-day only: an overnight window
-- has no meaning for a pharmacy that closes, and allowing end < start would
-- silently produce an empty constraint that makes the stop unroutable.
-- ----------------------------------------------------------------------------

ALTER TABLE orders DROP CONSTRAINT IF EXISTS chk_orders_requested_time_range;
ALTER TABLE orders
    ADD CONSTRAINT chk_orders_requested_time_range
    CHECK (
        (requested_time_start IS NULL) = (requested_time_end IS NULL)
        AND (requested_time_start IS NULL OR requested_time_start < requested_time_end)
    );

-- ----------------------------------------------------------------------------
-- "Which of today's stops can this route not reach?"
--
-- Asked on every optimize run to decide what gets appended rather than routed,
-- and by the dashboard to nudge staff toward fixing an address. Partial,
-- because the answer is almost always a short list.
-- ----------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_orders_ungeocoded
    ON orders(organization_id, delivery_date)
    WHERE latitude IS NULL AND status IN ('in_pharmacy', 'picked_up');

COMMENT ON COLUMN orders.place_id IS
    'Google Places identifier for the address the employee selected. Stable across sessions; lets an address be re-resolved without re-typing it. Not PII on its own, but it resolves to one, so it travels with the address.';

COMMENT ON COLUMN orders.formatted_address IS
    'The standardized address Google returned. `address` remains what staff see and edit; this is what was geocoded, kept so a coordinate can always be traced back to the string that produced it.';

COMMENT ON COLUMN orders.latitude IS
    'Delivery coordinate, snapshotted at order creation. PII — active-stop responses only (docs/privacy-rules.md), redacted from logs. NULL means the address was never geocoded, so the stop is appended to a route rather than optimized.';

COMMENT ON COLUMN orders.requested_time_start IS
    'Start of the interval the pharmacy promised the patient. Fed to the route optimizer as a time window. Finer than delivery_window, wider than requested_delivery_time; all three may coexist.';

COMMENT ON COLUMN organizations.latitude IS
    'The pharmacy coordinate, used as the depot a driver route starts from. Not PII — a business address.';

-- ----------------------------------------------------------------------------
-- ROLLBACK NOTE
--
-- Every column, constraint, and index here drops cleanly, and nothing else
-- references them:
--
--   ALTER TABLE orders DROP COLUMN place_id, DROP COLUMN formatted_address,
--     DROP COLUMN latitude, DROP COLUMN longitude, DROP COLUMN geocoded_at,
--     DROP COLUMN requested_time_start, DROP COLUMN requested_time_end;
--   (and the matching columns on clients and organizations)
--
-- Rolling back loses every geocode, which means re-picking each address in the
-- dashboard to restore them. Routing then falls back to the previous ordering,
-- which is the same degraded path a provider outage already takes.
-- ----------------------------------------------------------------------------
