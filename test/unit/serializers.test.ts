import { describe, expect, it } from "vitest";

import type { OrderRow } from "../../src/modules/orders/repository.js";
import {
  toAdminOrderView,
  toDriverOrderView,
} from "../../src/modules/orders/serializers.js";
import {
  TERMINAL_STATUSES,
  type OrderStatus,
} from "../../src/modules/orders/stateMachine.js";

const PII_FIELDS = ["patient_name", "address", "phone_number"] as const;

function makeOrder(status: OrderStatus): OrderRow {
  const now = new Date("2026-08-16T10:00:00Z");
  return {
    id: "11111111-1111-1111-1111-111111111111",
    organization_id: "22222222-2222-2222-2222-222222222222",
    driver_id: "33333333-3333-3333-3333-333333333333",
    client_id: "44444444-4444-4444-4444-444444444444",
    patient_name: "Marie Tremblay",
    address: "1250 Rue Sainte-Catherine O, Montréal",
    phone_number: "+15145550142",
    delivery_date: "2026-08-16",
    delivery_window: "AM",
    payment_status: "unpaid",
    payment_collected: false,
    payment_collected_at: null,
    payment_method: null,
    amount_collected: null,
    amount_due: 42.5,
    status,
    sequence_number: 3,
    requires_cooler_bag: true,
    cooler_bag_confirmed: null,
    picked_up_at: now,
    completed_at: status === "completed" ? now : null,
    returned_at: status === "returned" ? now : null,
    cancelled_at: status === "cancelled" ? now : null,
    created_at: now,
    updated_at: now,
  };
}

describe("driver PII serializer (PRD §8.3)", () => {
  it("includes patient details while the delivery is active", () => {
    for (const status of ["in_pharmacy", "picked_up"] as const) {
      const view = toDriverOrderView(makeOrder(status)) as Record<string, unknown>;
      expect(view.patient_name).toBe("Marie Tremblay");
      expect(view.address).toContain("Sainte-Catherine");
      expect(view.phone_number).toBe("+15145550142");
    }
  });

  it("omits patient details entirely once the order is terminal", () => {
    // §8.3: server-side enforcement is what makes this real — a client-only
    // cache wipe is not a control.
    for (const status of TERMINAL_STATUSES) {
      const view = toDriverOrderView(makeOrder(status)) as Record<string, unknown>;

      for (const field of PII_FIELDS) {
        expect(view, `${status} leaked ${field}`).not.toHaveProperty(field);
      }
    }
  });

  it("leaves no patient data anywhere in the serialized terminal payload", () => {
    // Guards against a nested or renamed field carrying the value through.
    for (const status of TERMINAL_STATUSES) {
      const json = JSON.stringify(toDriverOrderView(makeOrder(status)));
      expect(json).not.toContain("Marie");
      expect(json).not.toContain("Sainte-Catherine");
      expect(json).not.toContain("5145550142");
    }
  });

  it("still returns the identifier, outcome and timing of a closed delivery", () => {
    const view = toDriverOrderView(makeOrder("completed")) as Record<string, unknown>;
    expect(view.id).toBeTruthy();
    expect(view.status).toBe("completed");
    expect(view.completed_at).toBe("2026-08-16T10:00:00.000Z");
    // Needed for the post-delivery cooler-bag prompt (§5.6).
    expect(view.requires_cooler_bag).toBe(true);
  });

  it("never exposes payment method or collected amount to the driver view", () => {
    const view = toDriverOrderView(makeOrder("picked_up")) as Record<string, unknown>;
    expect(view).not.toHaveProperty("payment_method");
    expect(view).not.toHaveProperty("amount_collected");
  });
});

describe("admin serializer", () => {
  it("keeps patient details for every status, including terminal ones", () => {
    // The row persists server-side for admin history and reporting (§8.3).
    for (const status of TERMINAL_STATUSES) {
      const view = toAdminOrderView(makeOrder(status));
      expect(view.patient_name).toBe("Marie Tremblay");
      expect(view.address).toContain("Sainte-Catherine");
    }
  });

  it("serializes timestamps as ISO 8601 UTC", () => {
    const view = toAdminOrderView(makeOrder("completed"));
    expect(view.completed_at).toBe("2026-08-16T10:00:00.000Z");
    expect(view.created_at).toMatch(/Z$/);
  });

  it("keeps delivery_date a calendar date, not a timestamp", () => {
    // A delivery day has no timezone; converting it would shift the day for
    // any server not running in the pharmacy's zone.
    expect(toAdminOrderView(makeOrder("in_pharmacy")).delivery_date).toBe(
      "2026-08-16",
    );
  });
});
