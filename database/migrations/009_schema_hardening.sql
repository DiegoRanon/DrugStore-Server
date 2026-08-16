-- ============================================================================
-- Migration 009 — schema hardening (PRD §9.2 gaps #8, #9, #10, #11)
--
-- Also fixes something the base schema left unfinished: updated_at columns
-- default to now() on INSERT but nothing maintains them on UPDATE. Reporting
-- and the ?updated_since= polling fallback (PRD §7) both depend on that value
-- being true.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- updated_at maintenance
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE
    tbl TEXT;
BEGIN
    FOREACH tbl IN ARRAY ARRAY['organizations', 'clients', 'users', 'orders', 'invoices']
    LOOP
        EXECUTE format('DROP TRIGGER IF EXISTS trg_%1$s_updated_at ON %1$s', tbl);
        EXECUTE format(
            'CREATE TRIGGER trg_%1$s_updated_at BEFORE UPDATE ON %1$s
             FOR EACH ROW EXECUTE FUNCTION set_updated_at()', tbl);
    END LOOP;
END
$$;

-- ----------------------------------------------------------------------------
-- #8 — driver_locations has no organization_id
--
-- Every tracking query is org-scoped. Denormalizing avoids a join to users on
-- the hottest write path in the system (~15s per active driver).
-- ----------------------------------------------------------------------------

ALTER TABLE driver_locations
    ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE;

UPDATE driver_locations dl
   SET organization_id = u.organization_id
  FROM users u
 WHERE u.id = dl.driver_id
   AND dl.organization_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_driver_locations_org_time
    ON driver_locations(organization_id, recorded_at DESC);

-- ----------------------------------------------------------------------------
-- #9 — duplicate sequence_number possible per driver/date
--
-- Scoped to non-terminal orders only: sequence_number is transient working
-- state, and closed deliveries keep whatever position they held.
-- ----------------------------------------------------------------------------

CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_driver_date_sequence
    ON orders(driver_id, delivery_date, sequence_number)
    WHERE status IN ('in_pharmacy', 'picked_up')
      AND driver_id IS NOT NULL
      AND sequence_number IS NOT NULL;

-- ----------------------------------------------------------------------------
-- #10 — notifications lack provider metadata
--
-- Needed for Twilio status callbacks and to distinguish a retryable failure
-- from a permanently invalid number.
-- ----------------------------------------------------------------------------

ALTER TABLE notifications
    ADD COLUMN IF NOT EXISTS provider_message_id VARCHAR(128),
    ADD COLUMN IF NOT EXISTS error_code          VARCHAR(32),
    ADD COLUMN IF NOT EXISTS error_message       VARCHAR(500),
    ADD COLUMN IF NOT EXISTS attempt_count       INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS last_attempt_at     TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS locale              CHAR(2) NOT NULL DEFAULT 'fr';

CREATE INDEX IF NOT EXISTS idx_notifications_provider_message
    ON notifications(provider_message_id)
    WHERE provider_message_id IS NOT NULL;

-- ----------------------------------------------------------------------------
-- #11 — AM/PM windows undefined
--
-- Stored per organization so notification copy and reporting agree on what
-- "AM" means. Times are local to the org's timezone.
-- ----------------------------------------------------------------------------

ALTER TABLE organizations
    ADD COLUMN IF NOT EXISTS timezone        VARCHAR(64) NOT NULL DEFAULT 'America/Toronto',
    ADD COLUMN IF NOT EXISTS locale          CHAR(2)     NOT NULL DEFAULT 'fr',
    ADD COLUMN IF NOT EXISTS am_window_start TIME        NOT NULL DEFAULT '09:00',
    ADD COLUMN IF NOT EXISTS am_window_end   TIME        NOT NULL DEFAULT '12:00',
    ADD COLUMN IF NOT EXISTS pm_window_start TIME        NOT NULL DEFAULT '13:00',
    ADD COLUMN IF NOT EXISTS pm_window_end   TIME        NOT NULL DEFAULT '17:00';

ALTER TABLE organizations
    DROP CONSTRAINT IF EXISTS chk_org_locale;

ALTER TABLE organizations
    ADD CONSTRAINT chk_org_locale CHECK (locale IN ('fr', 'en'));

-- ----------------------------------------------------------------------------
-- Reporting indexes
--
-- Reports are computed from order_status_events over a date range (PRD §5.10),
-- and the admin order list filters by org + delivery date + status.
-- ----------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_order_status_events_occurred
    ON order_status_events(occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_order_status_events_status_occurred
    ON order_status_events(status, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_orders_org_date_status
    ON orders(organization_id, delivery_date, status);

CREATE INDEX IF NOT EXISTS idx_orders_org_updated
    ON orders(organization_id, updated_at DESC);
