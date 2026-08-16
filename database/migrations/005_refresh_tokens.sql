-- ============================================================================
-- Migration 005 — refresh token storage (PRD §9.1 gap #4)
--
-- Without server-side session state a compromised session cannot be revoked,
-- and deactivating a driver would not cut off their existing access.
--
-- Tokens are opaque and stored ONLY as a SHA-256 hash: a database read must
-- not yield a usable credential.
-- ============================================================================

CREATE TABLE IF NOT EXISTS refresh_tokens (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash      CHAR(64) NOT NULL UNIQUE,   -- SHA-256 hex of the opaque token
    expires_at      TIMESTAMPTZ NOT NULL,
    revoked_at      TIMESTAMPTZ,
    revoked_reason  VARCHAR(50),                -- 'rotated' | 'logout' | 'reuse_detected' | 'user_deactivated'

    -- Rotation chain. On refresh the presented token is revoked and a new row
    -- is created pointing back at it, so replay of an already-rotated token is
    -- detectable and can revoke the whole family.
    rotated_from_id UUID REFERENCES refresh_tokens(id) ON DELETE SET NULL,
    family_id       UUID NOT NULL,              -- stable across a rotation chain

    user_agent      VARCHAR(255),
    ip_address      INET,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_family ON refresh_tokens(family_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_expires ON refresh_tokens(expires_at);

COMMENT ON TABLE refresh_tokens IS
    'Opaque refresh tokens, 30-day TTL, rotated on every use (PRD §4.2). Expired rows are purged by a scheduled job (PRD §8.5).';
