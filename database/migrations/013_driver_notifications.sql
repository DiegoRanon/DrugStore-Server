-- ============================================================================
-- Migration 013 — driver_notifications
--
-- "Le livreur recoit une notification et la commande apparait dans la section
--  en pharmacie." (domain_workflow.md, avant prise en charge)
--
-- and, mid-shift:
--
-- "le livreur … reste à l'affut des commandes pouvant être ajouter par la
--  pharmacie durant son shift. Si cela arrive, le livreur doit repasser par la
--  pharmacie à sa discrétion."
--
-- A driver who misses a late addition drives home with a package still on the
-- counter, so the server has to record that something changed rather than
-- leave the app to notice.
--
-- WHY NOT THE EXISTING notifications TABLE
--
-- That one is keyed to channel ∈ (sms, email) plus a recipient string, and
-- exists for patient messaging (PRD §5.9). This is an in-app feed for one
-- known user. Overloading a table whose every column means something else
-- would make both features harder to reason about.
--
-- WHAT THIS IS NOT: there are no device tokens and no push provider here. The
-- app polls its queue and this feed. Real push can sit on top of these rows
-- later without changing them.
-- ============================================================================

CREATE TYPE driver_notification_type AS ENUM (
    'order_assigned',
    'order_ready',
    'order_unassigned',
    'order_cancelled'
);

CREATE TABLE IF NOT EXISTS driver_notifications (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    driver_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    order_id        UUID REFERENCES orders(id) ON DELETE CASCADE,
    type            driver_notification_type NOT NULL,
    delivery_date   DATE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    read_at         TIMESTAMPTZ
);

-- The feed is always read newest-first for one driver; unread is the hot path.
CREATE INDEX IF NOT EXISTS idx_driver_notifications_driver_time
    ON driver_notifications(driver_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_driver_notifications_unread
    ON driver_notifications(driver_id, created_at DESC)
    WHERE read_at IS NULL;

COMMENT ON TABLE driver_notifications IS
    'In-app feed telling a driver an order was assigned, readied, pulled, or cancelled. No PII: the order id is a handle the driver resolves through their own queue, which applies the usual scoping.';

-- ----------------------------------------------------------------------------
-- ROLLBACK NOTE
--
-- DROP TABLE driver_notifications; DROP TYPE driver_notification_type;
-- Nothing else references either.
-- ----------------------------------------------------------------------------
