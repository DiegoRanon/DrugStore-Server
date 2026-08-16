-- ============================================================================
-- Migration 007 — PII access audit trail (PRD §9.1 gap #5, §8.4)
--
-- Law 25 accountability requires knowing who accessed personal information.
-- order_status_events covers status CHANGES only; this covers READS.
--
-- The table is append-only: a trigger rejects UPDATE and DELETE outright, so
-- the trail holds even if the application role owns the table (revoking
-- grants alone would not stop a table owner).
-- ============================================================================

CREATE TABLE IF NOT EXISTS access_audit_log (
    id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    actor_user_id       UUID REFERENCES users(id) ON DELETE SET NULL,
    actor_role          user_role,
    organization_id     UUID,

    action              VARCHAR(64) NOT NULL,   -- 'order.detail.read', 'report.export', ...
    resource_type       VARCHAR(64) NOT NULL,   -- 'order', 'client', 'report'
    resource_ids        UUID[],                 -- specific rows, when bounded
    record_count        INTEGER,                -- scope size for list/export reads

    ip_address          INET,
    user_agent          VARCHAR(255),
    request_id          VARCHAR(64),

    occurred_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_access_audit_actor ON access_audit_log(actor_user_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_access_audit_org ON access_audit_log(organization_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_access_audit_occurred ON access_audit_log(occurred_at DESC);

-- ----------------------------------------------------------------------------
-- Append-only enforcement
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION reject_audit_log_mutation() RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'access_audit_log is append-only; % is not permitted', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_access_audit_log_immutable ON access_audit_log;

CREATE TRIGGER trg_access_audit_log_immutable
    BEFORE UPDATE OR DELETE ON access_audit_log
    FOR EACH ROW EXECUTE FUNCTION reject_audit_log_mutation();

COMMENT ON TABLE access_audit_log IS
    'Append-only record of every PII read by an admin (PRD §8.4). Writes go through auditPiiRead() in the application layer.';
