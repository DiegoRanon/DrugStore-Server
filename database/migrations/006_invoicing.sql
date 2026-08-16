-- ============================================================================
-- Migration 006 — delivery-service invoicing (PRD §9.1 gap #2, §9.2 gap #12)
--
-- This bills the PHARMACY for delivery services rendered. It is unrelated to
-- orders.amount_due, which is what the patient owes at the door.
--
-- Privacy: invoice lines reference order IDs only. No patient name, address,
-- or phone may ever be added to these tables (PRD §5.11).
-- ============================================================================

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'invoice_status') THEN
        CREATE TYPE invoice_status AS ENUM ('draft', 'issued', 'paid', 'void');
    END IF;
END
$$;

-- ----------------------------------------------------------------------------
-- Per-delivery rate charged to the organization
-- ----------------------------------------------------------------------------

ALTER TABLE organizations
    ADD COLUMN IF NOT EXISTS delivery_rate NUMERIC(10, 2) NOT NULL DEFAULT 0;

ALTER TABLE organizations
    DROP CONSTRAINT IF EXISTS chk_delivery_rate_non_negative;

ALTER TABLE organizations
    ADD CONSTRAINT chk_delivery_rate_non_negative
    CHECK (delivery_rate >= 0);

COMMENT ON COLUMN organizations.delivery_rate IS
    'Current flat per-delivery rate. Never read when displaying a historical invoice — each line item snapshots the rate that applied when it was generated (PRD §9.2 #12).';

-- ----------------------------------------------------------------------------
-- INVOICES
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS invoices (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

    invoice_number      VARCHAR(32) NOT NULL UNIQUE,
    period_start        DATE NOT NULL,
    period_end          DATE NOT NULL,

    status              invoice_status NOT NULL DEFAULT 'draft',
    delivery_count      INTEGER NOT NULL DEFAULT 0,
    subtotal            NUMERIC(12, 2) NOT NULL DEFAULT 0,
    total               NUMERIC(12, 2) NOT NULL DEFAULT 0,
    currency            CHAR(3) NOT NULL DEFAULT 'CAD',

    issued_at           TIMESTAMPTZ,
    paid_at             TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT chk_invoice_period CHECK (period_end >= period_start)
);

-- Generation is idempotent: re-running the monthly job for a period that has
-- already been invoiced updates the existing draft rather than duplicating it.
CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_org_period
    ON invoices(organization_id, period_start, period_end);

CREATE INDEX IF NOT EXISTS idx_invoices_organization ON invoices(organization_id);

-- ----------------------------------------------------------------------------
-- INVOICE LINE ITEMS — one per billable delivery
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS invoice_line_items (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    invoice_id      UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
    order_id        UUID NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,

    -- Snapshot of the rate at generation time. Changing organizations
    -- .delivery_rate must never retroactively alter a past invoice.
    unit_rate       NUMERIC(10, 2) NOT NULL,
    quantity        INTEGER NOT NULL DEFAULT 1,
    amount          NUMERIC(12, 2) NOT NULL,

    -- Logistical context only — deliberately no patient-identifying columns.
    delivery_date   DATE NOT NULL,
    order_status    order_status NOT NULL,

    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT chk_line_item_quantity CHECK (quantity > 0),
    CONSTRAINT chk_line_item_rate CHECK (unit_rate >= 0)
);

-- An order is billed exactly once. Voiding an invoice cascades its line items
-- away, which frees those orders for regeneration.
CREATE UNIQUE INDEX IF NOT EXISTS idx_invoice_line_items_order
    ON invoice_line_items(order_id);

CREATE INDEX IF NOT EXISTS idx_invoice_line_items_invoice
    ON invoice_line_items(invoice_id);

COMMENT ON TABLE invoice_line_items IS
    'One row per billable delivery. Order IDs only — adding any patient-identifying column here violates PRD §5.11.';
