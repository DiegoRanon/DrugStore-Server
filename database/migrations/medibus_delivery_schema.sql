-- ============================================================================
-- Medibus Delivery App (B2B) — MVP Database Schema
-- PostgreSQL
--
-- Scope: logistics only. No medical, pharmaceutical, or prescription data
-- is modeled anywhere in this schema, per MVP requirement (section 4).
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto"; -- for gen_random_uuid()

-- ----------------------------------------------------------------------------
-- ENUM TYPES
-- ----------------------------------------------------------------------------

CREATE TYPE user_role AS ENUM ('admin', 'driver');

CREATE TYPE delivery_window AS ENUM ('AM', 'PM');

CREATE TYPE order_status AS ENUM (
    'in_pharmacy',   -- created, waiting at the medibus
    'picked_up',     -- "prise en charge" - driver has the package
    'completed',     -- delivered, PoD confirmed
    'returned'       -- patient unavailable; package brought back to the medibus
);

CREATE TYPE payment_status AS ENUM ('paid', 'unpaid');

CREATE TYPE payment_method AS ENUM ('cash', 'card');

CREATE TYPE notification_channel AS ENUM ('sms', 'email');

CREATE TYPE notification_status AS ENUM ('queued', 'sent', 'failed');

-- ----------------------------------------------------------------------------
-- ORGANIZATIONS (medibuss / pharmacies — the B2B clients)
-- ----------------------------------------------------------------------------

CREATE TABLE organizations (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            VARCHAR(255) NOT NULL,
    address         VARCHAR(500),
    phone           VARCHAR(50),
    email           VARCHAR(255),
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ----------------------------------------------------------------------------
-- CLIENTS (patients saved against an organization, so staff pick from a
-- saved list instead of re-typing name/address/phone for every delivery)
-- ----------------------------------------------------------------------------

CREATE TABLE clients (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name                VARCHAR(255) NOT NULL,
    address             VARCHAR(500) NOT NULL,
    phone_number        VARCHAR(50) NOT NULL,
    notes               VARCHAR(500),
    is_active           BOOLEAN NOT NULL DEFAULT TRUE,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_clients_organization ON clients(organization_id);
CREATE INDEX idx_clients_name ON clients(organization_id, name);

-- ----------------------------------------------------------------------------
-- INVITE CODES (org keys used to link a driver to an organization)
-- ----------------------------------------------------------------------------

CREATE TABLE invite_codes (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id         UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    code                    VARCHAR(32) NOT NULL UNIQUE,
    is_active               BOOLEAN NOT NULL DEFAULT TRUE,
    expires_at              TIMESTAMPTZ,
    redeemed_by_user_id     UUID, -- FK added below, after users exists
    redeemed_at             TIMESTAMPTZ,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_invite_codes_org ON invite_codes(organization_id);

-- ----------------------------------------------------------------------------
-- USERS (unified login — admin or driver role)
-- ----------------------------------------------------------------------------

CREATE TABLE users (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL,
    role            user_role NOT NULL,
    email           VARCHAR(255) NOT NULL UNIQUE,
    password_hash   VARCHAR(255) NOT NULL,
    phone           VARCHAR(50),
    first_name      VARCHAR(100) NOT NULL,
    last_name       VARCHAR(100) NOT NULL,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT chk_admin_has_organization
        CHECK (role <> 'admin' OR organization_id IS NOT NULL)
);

CREATE INDEX idx_users_organization ON users(organization_id);
CREATE INDEX idx_users_role ON users(role);

-- Exactly one admin account per organization (partial unique index — only
-- applies to rows where role = 'admin', drivers are unaffected)
CREATE UNIQUE INDEX idx_one_admin_per_organization
    ON users(organization_id)
    WHERE role = 'admin';

ALTER TABLE invite_codes
    ADD CONSTRAINT fk_invite_codes_redeemed_by
    FOREIGN KEY (redeemed_by_user_id) REFERENCES users(id) ON DELETE SET NULL;

-- ----------------------------------------------------------------------------
-- ORDERS (the delivery itself — logistics data only, per MVP section 4)
-- ----------------------------------------------------------------------------

CREATE TABLE orders (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id         UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    driver_id               UUID REFERENCES users(id) ON DELETE SET NULL,
    client_id               UUID NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,

    -- snapshot of the client's logistics info at order creation time (encrypt
    -- at rest/in transit at app layer). Pre-filled from `clients` on insert
    -- and editable per-order, so a later edit to the client record never
    -- silently rewrites past delivery history.
    patient_name            VARCHAR(255) NOT NULL,
    address                 VARCHAR(500) NOT NULL,
    phone_number            VARCHAR(50) NOT NULL,

    delivery_date           DATE NOT NULL,
    delivery_window         delivery_window NOT NULL,

    payment_status          payment_status NOT NULL DEFAULT 'unpaid',
    payment_collected       BOOLEAN NOT NULL DEFAULT FALSE,
    payment_collected_at    TIMESTAMPTZ,
    payment_method          payment_method, -- set by the driver: 'cash' or 'card'
    amount_collected        NUMERIC(10, 2), -- set by the driver at drop-off

    status                  order_status NOT NULL DEFAULT 'in_pharmacy',
    sequence_number          INTEGER, -- position in the driver's optimized route/queue

    requires_cooler_bag     BOOLEAN NOT NULL DEFAULT FALSE,
    cooler_bag_confirmed    BOOLEAN, -- post-delivery quality-control check

    picked_up_at            TIMESTAMPTZ,
    completed_at            TIMESTAMPTZ,
    returned_at             TIMESTAMPTZ, -- set when the driver taps "Return Order"

    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- if the driver marks payment as collected, method + amount must be recorded
    CONSTRAINT chk_payment_collected_details
        CHECK (payment_collected = FALSE OR (payment_method IS NOT NULL AND amount_collected IS NOT NULL)),

    -- a terminal status must carry its timestamp, so reporting never has to
    -- guess when a delivery actually closed
    CONSTRAINT chk_terminal_status_timestamp
        CHECK (
            (status <> 'completed' OR completed_at IS NOT NULL)
            AND (status <> 'returned' OR returned_at IS NOT NULL)
        )
);

CREATE INDEX idx_orders_organization ON orders(organization_id);
CREATE INDEX idx_orders_client ON orders(client_id);
CREATE INDEX idx_orders_driver ON orders(driver_id);
CREATE INDEX idx_orders_status ON orders(status);
CREATE INDEX idx_orders_delivery_date ON orders(delivery_date);

-- ----------------------------------------------------------------------------
-- ORDER STATUS EVENTS (audit trail — feeds admin reports: delivery times,
-- success rates, etc.)
-- ----------------------------------------------------------------------------

CREATE TABLE order_status_events (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id            UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    status              order_status NOT NULL,
    changed_by_user_id  UUID REFERENCES users(id) ON DELETE SET NULL,
    occurred_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_order_status_events_order ON order_status_events(order_id);

-- ----------------------------------------------------------------------------
-- DRIVER LOCATIONS (real-time geolocation log, powers admin live tracking
-- and Mapbox route optimization)
-- ----------------------------------------------------------------------------

CREATE TABLE driver_locations (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    driver_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    latitude     DOUBLE PRECISION NOT NULL,
    longitude    DOUBLE PRECISION NOT NULL,
    recorded_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_driver_locations_driver_time ON driver_locations(driver_id, recorded_at DESC);

-- ----------------------------------------------------------------------------
-- NOTIFICATIONS (Twilio-powered SMS/email log to the end client)
-- ----------------------------------------------------------------------------

CREATE TABLE notifications (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id      UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    channel       notification_channel NOT NULL,
    recipient     VARCHAR(255) NOT NULL, -- phone or email, matches order at send time
    message       VARCHAR(500),
    status        notification_status NOT NULL DEFAULT 'queued',
    sent_at       TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_notifications_order ON notifications(order_id);

-- ============================================================================
-- Notes for implementation (not enforced at the DB layer):
--
-- 1. Encryption at rest (section 8) is typically handled via AWS KMS-backed
--    volume/column encryption, not application-level table design — but the
--    PII columns to protect are: users.phone, clients.name, clients.address,
--    clients.phone_number, orders.patient_name, orders.address,
--    orders.phone_number.
--
-- 2. Data minimization on the driver device (section 8) is a client-side/API
--    concern: once orders.status is terminal ('completed' OR 'returned'), the
--    API should stop returning patient_name/address/phone_number to the driver
--    app, even though the row persists server-side for admin history/reporting.
--
-- 3. "sequence_number" on orders is a simple slot for the Mapbox-optimized
--    route order within a driver's active queue; it's recalculated whenever
--    the queue changes and isn't meant as a permanent record.
--
-- 4. 'returned' is terminal, same as 'completed'. It means the patient was
--    unavailable and the physical package went back to the medibus; it is
--    never a step on the way to 'completed'. A second delivery attempt is a
--    NEW order, which keeps order_status_events readable as one attempt per
--    order. Reporting convention: success rate = completed / (completed +
--    returned). Per MVP section 5 the driver taps a single button, so no
--    reason code is captured; add one only if admins ask for it later.
-- ============================================================================
