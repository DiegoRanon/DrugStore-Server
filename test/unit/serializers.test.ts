import { describe, expect, it } from "vitest";

import type {
  OrderPackageRow,
  OrderRow,
} from "../../src/modules/orders/repository.js";
import {
  toAdminOrderView,
  toDriverOrderView,
} from "../../src/modules/orders/serializers.js";
import {
  PII_VISIBLE_STATUSES,
  TERMINAL_STATUSES,
  type OrderStatus,
} from "../../src/modules/orders/stateMachine.js";

const PII_FIELDS = [
  "patient_name",
  "address",
  "phone_number",
  "authorized_recipient",
] as const;

const ALL_STATUSES: OrderStatus[] = [
  "scheduled",
  "in_pharmacy",
  "picked_up",
  "completed",
  "returned",
  "returned_to_pharmacy",
  "cancelled",
];

/** Every status at which the driver must NOT see who or where. */
const CLOSED_STATUSES = ALL_STATUSES.filter(
  (status) => !PII_VISIBLE_STATUSES.includes(status),
);

const now = new Date("2026-08-16T10:00:00Z");

function makeOrder(status: OrderStatus): OrderRow {
  const returned = status === "returned" || status === "returned_to_pharmacy";
  return {
    id: "11111111-1111-1111-1111-111111111111",
    organization_id: "22222222-2222-2222-2222-222222222222",
    driver_id: "33333333-3333-3333-3333-333333333333",
    client_id: "44444444-4444-4444-4444-444444444444",
    patient_name: "Marie Tremblay",
    address: "1250 Rue Sainte-Catherine O, Montréal",
    phone_number: "+15145550142",
    authorized_recipient: "Luc Bergeron (neighbour)",
    delivery_date: "2026-08-16",
    delivery_window: "AM",
    requested_delivery_time: "10:30:00",
    payment_status: "unpaid",
    payment_collected: false,
    payment_collected_at: null,
    payment_method: null,
    amount_collected: null,
    amount_due: 42.5,
    payment_exception: null,
    payment_exception_note: null,
    status,
    is_priority: false,
    sequence_number: 3,
    failure_reason: returned ? "customer_absent" : null,
    failure_note: returned ? "Buzzed twice, Marie did not answer" : null,
    requires_cooler_bag: true,
    cooler_bag_confirmed: null,
    pickup_package_count: 2,
    ready_at: status === "scheduled" ? null : now,
    picked_up_at: now,
    completed_at: status === "completed" ? now : null,
    returned_at: returned ? now : null,
    returned_to_pharmacy_at: status === "returned_to_pharmacy" ? now : null,
    cancelled_at: status === "cancelled" ? now : null,
    created_at: now,
    updated_at: now,
  };
}

function makePackages(): OrderPackageRow[] {
  return [
    {
      id: "55555555-5555-5555-5555-555555555555",
      order_id: "11111111-1111-1111-1111-111111111111",
      label_code: "4412-A",
      package_type: "bag",
      position: 1,
      created_at: now,
    },
    {
      id: "66666666-6666-6666-6666-666666666666",
      order_id: "11111111-1111-1111-1111-111111111111",
      label_code: "4412-B",
      package_type: "cooler",
      position: 2,
      created_at: now,
    },
  ];
}

describe("driver PII serializer", () => {
  it("includes patient details while the delivery is active", () => {
    for (const status of ["in_pharmacy", "picked_up"] as const) {
      const view = toDriverOrderView(makeOrder(status)) as Record<
        string,
        unknown
      >;
      expect(view.patient_name).toBe("Marie Tremblay");
      expect(view.address).toContain("Sainte-Catherine");
      expect(view.phone_number).toBe("+15145550142");
      // Scénario A: the driver has to check the person at the door may accept.
      expect(view.authorized_recipient).toBe("Luc Bergeron (neighbour)");
    }
  });

  /**
   * The regression this whole file exists to catch.
   *
   * "returned" is NOT terminal — the driver still owes the pharmacy a handover
   * — but the delivery attempt is over, so the patient's details must be gone.
   * A serializer that branches on isTerminal() instead of showsPatientDetails()
   * passes every other test in this suite and fails this one.
   */
  it("omits patient details on a failed delivery awaiting handover", () => {
    const view = toDriverOrderView(makeOrder("returned")) as Record<
      string,
      unknown
    >;

    for (const field of PII_FIELDS) {
      expect(view, `returned leaked ${field}`).not.toHaveProperty(field);
    }

    // And it is genuinely still open — this is not passing because the status
    // quietly became terminal.
    expect(TERMINAL_STATUSES).not.toContain("returned");
    expect(view.status).toBe("returned");
  });

  it("omits patient details at every status past the delivery attempt", () => {
    // Server-side enforcement is what makes this real — a client-only cache
    // wipe is not a control.
    for (const status of CLOSED_STATUSES) {
      const view = toDriverOrderView(makeOrder(status)) as Record<
        string,
        unknown
      >;

      for (const field of PII_FIELDS) {
        expect(view, `${status} leaked ${field}`).not.toHaveProperty(field);
      }
    }
  });

  it("leaves no patient data anywhere in a serialized closed payload", () => {
    // Guards against a nested or renamed field carrying the value through.
    for (const status of CLOSED_STATUSES) {
      const json = JSON.stringify(
        toDriverOrderView(makeOrder(status), makePackages()),
      );
      expect(json, status).not.toContain("Marie");
      expect(json, status).not.toContain("Sainte-Catherine");
      expect(json, status).not.toContain("5145550142");
      expect(json, status).not.toContain("Bergeron");
    }
  });

  it("keeps the driver's free-text failure note out of every driver payload", () => {
    // The note is the driver's own words and routinely names a person; it goes
    // to the pharmacy, not back down to the app.
    for (const status of ALL_STATUSES) {
      const json = JSON.stringify(
        toDriverOrderView(makeOrder(status), makePackages()),
      );
      expect(json, status).not.toContain("Buzzed twice");
    }
  });

  it("still returns the identifier, outcome and timing of a closed delivery", () => {
    const view = toDriverOrderView(makeOrder("completed")) as Record<
      string,
      unknown
    >;
    expect(view.id).toBeTruthy();
    expect(view.status).toBe("completed");
    expect(view.completed_at).toBe("2026-08-16T10:00:00.000Z");
    // Needed for the post-delivery cooler-bag prompt (PRD §5.6).
    expect(view.requires_cooler_bag).toBe(true);
  });

  it("keeps label codes on a returned order so the right bags go back", () => {
    // A label code is a bag number, not information about a person, and the
    // driver needs it to hand the correct parcels to the employee.
    const view = toDriverOrderView(
      makeOrder("returned"),
      makePackages(),
    ) as Record<string, unknown>;

    expect(view.package_count).toBe(2);
    expect(JSON.stringify(view.packages)).toContain("4412-A");
    // And the pharmacy needs to know why it came back.
    expect(view.failure_reason).toBe("customer_absent");
  });

  it("carries label codes to the driver for the pickup check", () => {
    const view = toDriverOrderView(
      makeOrder("in_pharmacy"),
      makePackages(),
    ) as Record<string, unknown>;
    expect(view.package_count).toBe(2);
    expect(JSON.stringify(view.packages)).toContain("4412-B");
  });

  it("never exposes payment method or collected amount to the driver view", () => {
    const view = toDriverOrderView(makeOrder("picked_up")) as Record<
      string,
      unknown
    >;
    expect(view).not.toHaveProperty("payment_method");
    expect(view).not.toHaveProperty("amount_collected");
  });
});

describe("admin serializer", () => {
  it("keeps patient details for every status, including terminal ones", () => {
    // The row persists server-side for admin history and reporting.
    for (const status of TERMINAL_STATUSES) {
      const view = toAdminOrderView(makeOrder(status));
      expect(view.patient_name).toBe("Marie Tremblay");
      expect(view.address).toContain("Sainte-Catherine");
    }
  });

  it("gives the admin the failure reason and note a driver never sees back", () => {
    const view = toAdminOrderView(makeOrder("returned"));
    expect(view.failure_reason).toBe("customer_absent");
    expect(view.failure_note).toContain("Buzzed twice");
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

  it("reports the package list and its count", () => {
    const view = toAdminOrderView(makeOrder("in_pharmacy"), makePackages());
    expect(view.package_count).toBe(2);
    expect(view.packages.map((p) => p.label_code)).toEqual(["4412-A", "4412-B"]);
  });
});
