-- ============================================================================
-- Migration 012 — order_packages
--
-- "Le livreur prends les commandes prête en vérifiant que les étiquettes
--  correspondent aux commandes qu'il a sur son application en collaborant avec
--  l'employé." (domain_workflow.md, prise en charge)
--
-- The driver matches physical bag labels against the app at pickup. That needs
-- something to match against, which the schema had no room for.
--
-- WHAT THIS TABLE DELIBERATELY DOES NOT HAVE
--
-- No description, no free-text notes, no quantity of anything nameable. The
-- product constraint is "do not store prescription or medical information",
-- and a free-text line item is exactly where a medication name would end up.
-- label_code is what is printed on the bag; package_type is a closed enum.
-- There is nowhere here to type a drug name — the constraint is structural,
-- not a policy someone has to remember.
-- ============================================================================

CREATE TYPE package_type AS ENUM ('bag', 'cooler', 'tote', 'envelope');

CREATE TABLE IF NOT EXISTS order_packages (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id     UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    label_code   VARCHAR(32) NOT NULL,
    package_type package_type NOT NULL DEFAULT 'bag',
    position     INTEGER NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT uq_order_packages_position UNIQUE (order_id, position),
    CONSTRAINT chk_order_packages_position CHECK (position > 0)
);

CREATE INDEX IF NOT EXISTS idx_order_packages_order
    ON order_packages(order_id);

COMMENT ON TABLE order_packages IS
    'Physical parcels making up one delivery, for label verification at pickup. Logistics only — no medical, pharmaceutical, or prescription data is modeled here or anywhere else in this schema.';

COMMENT ON COLUMN order_packages.label_code IS
    'The identifier printed on the physical bag, e.g. 4412-A. What the driver reads aloud to the employee.';

-- ----------------------------------------------------------------------------
-- ROLLBACK NOTE
--
-- DROP TABLE order_packages; DROP TYPE package_type;  — no data outside this
-- table depends on it. orders.requires_cooler_bag predates it and stays
-- authoritative for the cooler-bag check.
-- ----------------------------------------------------------------------------
