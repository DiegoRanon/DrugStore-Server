-- ============================================================================
-- Migration 004 — amount owed on the order (PRD §9.1 gap #3)
--
-- Without this the driver has no amount to collect at the door, and
-- amount_collected cannot be reconciled against anything.
-- ============================================================================

ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS amount_due NUMERIC(10, 2);

ALTER TABLE orders
    DROP CONSTRAINT IF EXISTS chk_amount_due_non_negative;

ALTER TABLE orders
    ADD CONSTRAINT chk_amount_due_non_negative
    CHECK (amount_due IS NULL OR amount_due >= 0);

COMMENT ON COLUMN orders.amount_due IS
    'What the patient owes the pharmacy at the door, set by the admin at order creation. NULL means nothing to collect. This is unrelated to invoicing, which bills the pharmacy for delivery services (PRD §5.11).';
