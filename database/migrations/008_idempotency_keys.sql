-- ============================================================================
-- Migration 008 — idempotency keys (PRD §3)
--
-- The driver app runs on flaky mobile networks and retries. Without this, a
-- retried "complete delivery" call could write a second status event, or a
-- retried payment could double-record a collection.
--
-- Stored in Postgres rather than Redis deliberately: correctness of a delivery
-- record must not depend on a cache surviving.
-- ============================================================================

CREATE TABLE IF NOT EXISTS idempotency_keys (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id              UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    idempotency_key      VARCHAR(255) NOT NULL,

    -- SHA-256 of method + path + body. A replay with the same key but a
    -- different payload is a client bug and returns 409, rather than silently
    -- serving the wrong cached response.
    request_fingerprint  CHAR(64) NOT NULL,

    -- NULL while the first request is still in flight; a concurrent retry sees
    -- the reserved row and is told to back off.
    response_status      INTEGER,
    response_body        JSONB,
    completed_at         TIMESTAMPTZ,

    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at           TIMESTAMPTZ NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_idempotency_keys_user_key
    ON idempotency_keys(user_id, idempotency_key);

CREATE INDEX IF NOT EXISTS idx_idempotency_keys_expires
    ON idempotency_keys(expires_at);

COMMENT ON TABLE idempotency_keys IS
    'Replay cache for Idempotency-Key on driver mutations (PRD §3). Expired rows are purged by the retention job.';
