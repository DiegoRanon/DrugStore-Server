-- ============================================================================
-- Migration 001 — add the 'returned' order status
--
-- Only needed if the schema has ALREADY been applied to a database. For a
-- fresh install, medibus_delivery_schema.sql now contains these changes.
--
-- IMPORTANT: run the two steps as SEPARATE transactions. PostgreSQL does not
-- allow a newly added enum value to be used in the same transaction that
-- added it, and step 2's CHECK constraint references 'returned'.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- STEP 1 — extend the enum (run alone, no surrounding BEGIN/COMMIT)
-- ----------------------------------------------------------------------------

ALTER TYPE order_status ADD VALUE IF NOT EXISTS 'returned' AFTER 'completed';

-- ----------------------------------------------------------------------------
-- STEP 2 — add the timestamp column and terminal-state constraint
-- ----------------------------------------------------------------------------

BEGIN;

ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS returned_at TIMESTAMPTZ;

-- Backfill required before the constraint can be validated: any legacy row
-- already marked 'completed' without a completed_at would otherwise fail.
-- updated_at is the closest available approximation.
UPDATE orders
   SET completed_at = updated_at
 WHERE status = 'completed'
   AND completed_at IS NULL;

ALTER TABLE orders
    ADD CONSTRAINT chk_terminal_status_timestamp
    CHECK (
        (status <> 'completed' OR completed_at IS NOT NULL)
        AND (status <> 'returned' OR returned_at IS NOT NULL)
    );

COMMIT;

-- ----------------------------------------------------------------------------
-- ROLLBACK NOTE
--
-- PostgreSQL cannot remove a value from an enum. Reverting means recreating
-- order_status without 'returned' and rewriting every column that uses it
-- (orders.status, order_status_events.status), which requires downtime. Treat
-- step 1 as one-way and confirm the value name before running it.
-- ----------------------------------------------------------------------------
