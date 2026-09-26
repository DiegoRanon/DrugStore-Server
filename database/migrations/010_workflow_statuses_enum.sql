-- ============================================================================
-- Migration 010 — scheduled and returned_to_pharmacy statuses (enum only)
--
-- The client's domain workflow (medibus-driver-app/docs/Plans/domain_workflow.md)
-- describes two stages the four-state lifecycle cannot express:
--
--   1. "L'admin prépare digitalement la liste … La commande apparait ensuite
--      dans un calendrier visible uniquement par l'Admin." An order exists,
--      scheduled, before the staff have physically prepared it — and it must
--      not reach a driver until they declare it ready. Today an order is born
--      'in_pharmacy' and is visible to its driver immediately.
--
--   2. "Une fois les commandes retourné, le livreur peut confirmer sur
--      l'application que la pharmacie les as biens récupéré." A failed
--      delivery rides back in the driver's van and is handed to staff. Today
--      'returned' is terminal, so the return leg has nowhere to live.
--
-- IMPORTANT: this file MUST run outside a transaction. PostgreSQL does not
-- allow a newly added enum value to be used in the transaction that added it,
-- and migration 011 references both values in a CHECK constraint. The runner
-- honours the marker below.
--
-- @migration:no-transaction
-- ============================================================================

ALTER TYPE order_status ADD VALUE IF NOT EXISTS 'scheduled' BEFORE 'in_pharmacy';

ALTER TYPE order_status ADD VALUE IF NOT EXISTS 'returned_to_pharmacy' AFTER 'returned';

-- ----------------------------------------------------------------------------
-- ROLLBACK NOTE
--
-- Enum additions are one-way, exactly as documented in migrations 001 and 002.
-- Reverting means recreating order_status without these values and rewriting
-- every column that uses it (orders.status, order_status_events.status,
-- invoice_line_items.order_status), which requires downtime.
-- ----------------------------------------------------------------------------
