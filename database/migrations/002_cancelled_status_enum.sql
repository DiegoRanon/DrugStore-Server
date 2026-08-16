-- ============================================================================
-- Migration 002 — add the 'cancelled' order status (enum value only)
--
-- PRD §5.2 defines POST /v1/orders/:id/cancel and §5.3 states that an order
-- still sitting at the pharmacy "is cancelled, not returned" — but the
-- order_status enum shipped with only four values, leaving cancellation with
-- nowhere to go. This adds the missing terminal state.
--
-- IMPORTANT: this file MUST run outside a transaction. PostgreSQL does not
-- allow a newly added enum value to be used in the transaction that added it,
-- and migration 003 references 'cancelled' in a CHECK constraint. The runner
-- honours the marker below.
--
-- @migration:no-transaction
-- ============================================================================

ALTER TYPE order_status ADD VALUE IF NOT EXISTS 'cancelled' AFTER 'returned';

-- ----------------------------------------------------------------------------
-- ROLLBACK NOTE
--
-- Enum additions are one-way, exactly as documented in migration 001.
-- Reverting means recreating order_status without 'cancelled' and rewriting
-- every column that uses it (orders.status, order_status_events.status),
-- which requires downtime.
-- ----------------------------------------------------------------------------
