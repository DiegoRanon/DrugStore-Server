-- ============================================================================
-- Migration 003 — cancelled_at column and terminal-timestamp constraint
--
-- Companion to 002. Extends chk_terminal_status_timestamp so that every
-- terminal state carries its own timestamp: reporting never has to guess when
-- a delivery closed, and a transition that forgets its timestamp fails loudly
-- instead of corrupting the numbers.
-- ============================================================================

ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;

-- The constraint is recreated rather than amended — PostgreSQL has no
-- ALTER CONSTRAINT for CHECK expressions.
ALTER TABLE orders
    DROP CONSTRAINT IF EXISTS chk_terminal_status_timestamp;

ALTER TABLE orders
    ADD CONSTRAINT chk_terminal_status_timestamp
    CHECK (
        (status <> 'completed' OR completed_at IS NOT NULL)
        AND (status <> 'returned'  OR returned_at  IS NOT NULL)
        AND (status <> 'cancelled' OR cancelled_at IS NOT NULL)
    );

COMMENT ON COLUMN orders.cancelled_at IS
    'Set when an admin cancels an order that never left the pharmacy. Cancelled orders are excluded from the success-rate calculation (PRD §5.10), unlike returns.';
