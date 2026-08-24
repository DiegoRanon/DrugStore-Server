-- ============================================================================
-- Migration 011 — workflow columns for the client's domain flow
--
-- Companion to 010. Adds the data the pharmacy's real process needs and that
-- the API had nowhere to put:
--
--   requested_delivery_time  "date, heure" — the admin schedules a time, not
--                            just an AM/PM window. The window stays; this is
--                            the finer-grained ask when there is one.
--   authorized_recipient     "personne autorisé à réceptionner" — the driver
--                            must confirm the person at the door may accept.
--                            PII: active-stop responses only.
--   is_priority              "Si une commande doit être livrer prioritairement,
--                            l'employé le dit au livreur maintenant." Told
--                            verbally at pickup, so the driver can set it too.
--   ready_at                 stamped when staff declare the order prepared.
--   returned_to_pharmacy_at  stamped when staff take the package back.
--   failure_reason/_note     "doit justifier en sélectionnant que le client
--                            était absent. Il peut ajouter une note."
--   payment_exception        "Si le client n'a pas la possibilité de payer, le
--                            livreur doit appeler la pharmacie" — the outcome
--                            of that call, when the delivery still happened.
--   pickup_package_count     what the driver counted while checking labels
--                            against the employee.
-- ============================================================================

CREATE TYPE delivery_failure_reason AS ENUM (
    'customer_absent',
    'customer_refused',
    'wrong_address',
    'payment_refused',
    'other'
);

CREATE TYPE payment_exception AS ENUM (
    'waived_by_pharmacy',
    'deferred_to_pharmacy'
);

ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS requested_delivery_time  TIME,
    ADD COLUMN IF NOT EXISTS authorized_recipient     VARCHAR(255),
    ADD COLUMN IF NOT EXISTS is_priority              BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS ready_at                 TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS returned_to_pharmacy_at  TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS failure_reason           delivery_failure_reason,
    ADD COLUMN IF NOT EXISTS failure_note             VARCHAR(500),
    ADD COLUMN IF NOT EXISTS payment_exception        payment_exception,
    ADD COLUMN IF NOT EXISTS payment_exception_note   VARCHAR(500),
    ADD COLUMN IF NOT EXISTS pickup_package_count     INTEGER;

-- ----------------------------------------------------------------------------
-- Backfill before the constraints go on.
--
-- Every existing order was created straight into 'in_pharmacy', i.e. already
-- prepared, so its ready moment is its creation moment. And the old return
-- endpoint had exactly one meaning — PRD §5.3 called it "the Return Order
-- action for an unavailable patient" — so historical returns are recorded as
-- customer_absent rather than invented as 'other'.
-- ----------------------------------------------------------------------------

UPDATE orders SET ready_at = created_at
 WHERE ready_at IS NULL AND status <> 'cancelled';

UPDATE orders SET failure_reason = 'customer_absent'
 WHERE status = 'returned' AND failure_reason IS NULL;

-- ----------------------------------------------------------------------------
-- Timestamp constraints
--
-- Recreated rather than amended — PostgreSQL has no ALTER CONSTRAINT for CHECK
-- expressions. Note the split: 'returned' is no longer terminal (the package
-- is in the driver's van), so it moves out of the terminal constraint and into
-- the stage constraint alongside 'in_pharmacy'.
-- ----------------------------------------------------------------------------

ALTER TABLE orders
    DROP CONSTRAINT IF EXISTS chk_terminal_status_timestamp;

ALTER TABLE orders
    ADD CONSTRAINT chk_terminal_status_timestamp
    CHECK (
        (status <> 'completed'            OR completed_at            IS NOT NULL)
        AND (status <> 'returned_to_pharmacy' OR returned_to_pharmacy_at IS NOT NULL)
        AND (status <> 'cancelled'        OR cancelled_at            IS NOT NULL)
    );

ALTER TABLE orders
    DROP CONSTRAINT IF EXISTS chk_status_stage_timestamp;

ALTER TABLE orders
    ADD CONSTRAINT chk_status_stage_timestamp
    CHECK (
        -- Everything past the calendar has been declared ready by staff.
        (status IN ('scheduled', 'cancelled') OR ready_at IS NOT NULL)
        -- A handed-back package was a failed delivery first.
        AND (status NOT IN ('returned', 'returned_to_pharmacy')
             OR returned_at IS NOT NULL)
    );

-- A failed delivery must say why (domain_workflow.md, scénario B).
ALTER TABLE orders
    DROP CONSTRAINT IF EXISTS chk_failure_reason_present;

ALTER TABLE orders
    ADD CONSTRAINT chk_failure_reason_present
    CHECK (
        status NOT IN ('returned', 'returned_to_pharmacy')
        OR failure_reason IS NOT NULL
    );

ALTER TABLE orders
    DROP CONSTRAINT IF EXISTS chk_pickup_package_count_non_negative;

ALTER TABLE orders
    ADD CONSTRAINT chk_pickup_package_count_non_negative
    CHECK (pickup_package_count IS NULL OR pickup_package_count >= 0);

-- ----------------------------------------------------------------------------
-- "Le livreur retourne en pharmacie avant une certaine heure limite."
--
-- Org-level rather than per-shift: the pharmacy has one closing routine, not
-- one per driver. Local to the organization's timezone, like the AM/PM windows
-- added in migration 009.
-- ----------------------------------------------------------------------------

ALTER TABLE organizations
    ADD COLUMN IF NOT EXISTS return_deadline TIME NOT NULL DEFAULT '18:00';

-- ----------------------------------------------------------------------------
-- Priority stops sort to the front of the driver's queue.
-- ----------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_orders_org_date_priority
    ON orders(organization_id, delivery_date, is_priority DESC)
    WHERE status IN ('in_pharmacy', 'picked_up');

COMMENT ON COLUMN orders.authorized_recipient IS
    'Who may accept this delivery at the door. PII — returned to a driver only while the delivery is active (privacy rules), never on a closed one.';

COMMENT ON COLUMN orders.failure_note IS
    'Driver free text explaining a failed delivery. May name a person, so it is admin-only and redacted from logs.';

COMMENT ON COLUMN orders.payment_exception IS
    'Set when a delivery completed without collecting the money owed, after the driver called the pharmacy for instructions. Feeds end-of-shift reconciliation.';

-- ----------------------------------------------------------------------------
-- ROLLBACK NOTE
--
-- The columns and constraints here drop cleanly. The two enum values added in
-- 010 do not, so a full revert also needs the downtime described there. Drop
-- this migration's constraints before rolling back 010, or the CHECK
-- expressions will reference values that no longer exist.
-- ----------------------------------------------------------------------------
