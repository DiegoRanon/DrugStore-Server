import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { closeDb, db } from "../../src/db/knex.js";
import { closeRedis } from "../../src/db/redis.js";
import {
  createTestApp,
  createWorld,
  markReady,
  request,
  type TestWorld,
} from "../helpers/fixtures.js";

/**
 * The return leg, from the client's domain workflow.
 *
 * Scénario B: the customer does not answer, the driver marks the delivery
 * failed and says why. The package then rides back in the van until staff take
 * it at the counter — "Une fois les commandes retourné, le livreur peut
 * confirmer sur l'application que la pharmacie les as biens récupéré."
 *
 * The failure this prevents: treating a return as the end of the order, which
 * loses the leg where a real package is in transit and nobody has signed for
 * it. That was the old model, and the pharmacy could not tell the difference
 * between a bag in a van and a bag back on the shelf.
 */

let app: FastifyInstance;
let world: TestWorld;

const DATE = "2026-09-22";

beforeAll(async () => {
  app = await createTestApp();
});

afterAll(async () => {
  await app.close();
  await closeDb();
  await closeRedis();
});

beforeEach(async () => {
  world = await createWorld(app);
});

async function pickedUpOrder(overrides: Record<string, unknown> = {}) {
  const res = await request(app, {
    method: "POST",
    url: "/v1/orders",
    token: world.orgA.adminToken,
    payload: {
      client_id: world.orgA.clientId,
      driver_id: world.orgA.driverId,
      delivery_date: DATE,
      delivery_window: "AM",
      ...overrides,
    },
  });
  const order = await markReady(app, world.orgA.adminToken, res.json().id);
  await driver(`/v1/driver/orders/${order.id}/pickup`);
  return order;
}

function driver(
  url: string,
  payload?: unknown,
  method: "GET" | "POST" = "POST",
) {
  return request(app, { method, url, token: world.orgA.driverToken, payload });
}

describe("marking a delivery failed", () => {
  it("requires a reason", async () => {
    const order = await pickedUpOrder();
    const res = await driver(`/v1/driver/orders/${order.id}/return`);

    // A return with no explanation tells the pharmacy nothing about whether to
    // re-attempt, which is the only decision they have to make next.
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_FAILED");
  });

  it("rejects a reason outside the documented set", async () => {
    const order = await pickedUpOrder();
    const res = await driver(`/v1/driver/orders/${order.id}/return`, {
      reason: "felt_like_it",
    });
    expect(res.statusCode).toBe(400);
  });

  it("records the reason and the driver's optional note", async () => {
    const order = await pickedUpOrder();
    const res = await driver(`/v1/driver/orders/${order.id}/return`, {
      reason: "customer_refused",
      note: "Present but would not take the bag",
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("returned");

    const row = await db("orders").where({ id: order.id }).first();
    expect(row.failure_reason).toBe("customer_refused");
    expect(row.failure_note).toBe("Present but would not take the bag");
    expect(row.returned_at).not.toBeNull();
    // Not the end — nobody has taken the package back yet.
    expect(row.returned_to_pharmacy_at).toBeNull();
  });

  it("drops the patient's details the moment the attempt fails", async () => {
    const order = await pickedUpOrder();
    const res = await driver(`/v1/driver/orders/${order.id}/return`, {
      reason: "customer_absent",
    });

    const body = res.json();
    expect(body).not.toHaveProperty("patient_name");
    expect(body).not.toHaveProperty("address");
    expect(body).not.toHaveProperty("phone_number");
    expect(body).not.toHaveProperty("authorized_recipient");
    // And the driver's own note does not come back down to the device.
    expect(res.body).not.toContain("Present but");
  });

  it("keeps it out of the stops list and in a bucket of its own", async () => {
    const order = await pickedUpOrder();
    await driver(`/v1/driver/orders/${order.id}/return`, {
      reason: "customer_absent",
    });

    const queue = (
      await driver(`/v1/driver/queue?date=${DATE}`, undefined, "GET")
    ).json();

    // Not a stop: there is nothing left to deliver.
    expect(queue.stops).toHaveLength(0);
    // Not closed either: the driver still owes the pharmacy the package.
    expect(queue.closed).toHaveLength(0);
    expect(queue.to_return).toHaveLength(1);
    expect(queue.to_return[0].id).toBe(order.id);
    expect(queue.to_return[0].failure_reason).toBe("customer_absent");
  });

  it("stays unpaid, and refuses a collection", async () => {
    const order = await pickedUpOrder({ amount_due: 30 });
    await driver(`/v1/driver/orders/${order.id}/return`, {
      reason: "customer_absent",
    });

    const payment = await driver(`/v1/driver/orders/${order.id}/payment`, {
      payment_method: "cash",
      amount_collected: 30,
    });
    expect(payment.statusCode).toBe(409);

    const row = await db("orders").where({ id: order.id }).first();
    expect(row.payment_status).toBe("unpaid");
    expect(row.payment_collected).toBe(false);
  });
});

describe("handing the packages back", () => {
  it("closes the order and stamps the handover", async () => {
    const order = await pickedUpOrder();
    await driver(`/v1/driver/orders/${order.id}/return`, {
      reason: "customer_absent",
    });

    const res = await driver(`/v1/driver/orders/${order.id}/handover`);
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("returned_to_pharmacy");

    const row = await db("orders").where({ id: order.id }).first();
    expect(row.returned_to_pharmacy_at).not.toBeNull();
    // The reason survives: it is why the package came back, and the pharmacy
    // needs it to decide whether to re-attempt.
    expect(row.failure_reason).toBe("customer_absent");
  });

  it("hands the whole stack back in one call", async () => {
    // The driver empties the van at the counter in one go, not one bag at a
    // time while an employee waits.
    const orders = await Promise.all([
      pickedUpOrder(),
      pickedUpOrder(),
      pickedUpOrder(),
    ]);

    for (const order of orders) {
      await driver(`/v1/driver/orders/${order.id}/return`, {
        reason: "customer_absent",
      });
    }

    const res = await driver("/v1/driver/returns/handover", {
      order_ids: orders.map((o) => o.id),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().count).toBe(3);
    for (const stop of res.json().handed_over) {
      expect(stop.status).toBe("returned_to_pharmacy");
    }

    const queue = (
      await driver(`/v1/driver/queue?date=${DATE}`, undefined, "GET")
    ).json();
    expect(queue.to_return).toHaveLength(0);
    expect(queue.closed).toHaveLength(3);
  });

  it("hands back nothing when one of the batch is not returnable", async () => {
    // All or nothing: a partial success leaves the driver unsure which bags
    // the app still thinks they are carrying.
    const returned = await pickedUpOrder();
    await driver(`/v1/driver/orders/${returned.id}/return`, {
      reason: "customer_absent",
    });
    const stillOut = await pickedUpOrder();

    const res = await driver("/v1/driver/returns/handover", {
      order_ids: [returned.id, stillOut.id],
    });
    expect(res.statusCode).toBe(409);

    const row = await db("orders").where({ id: returned.id }).first();
    expect(row.status).toBe("returned");
    expect(row.returned_to_pharmacy_at).toBeNull();
  });

  it("refuses a second handover of the same package", async () => {
    const order = await pickedUpOrder();
    await driver(`/v1/driver/orders/${order.id}/return`, {
      reason: "customer_absent",
    });
    await driver(`/v1/driver/orders/${order.id}/handover`);

    const again = await driver(`/v1/driver/orders/${order.id}/handover`);
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe("ORDER_ALREADY_TERMINAL");
  });

  it("refuses a handover of a package that never failed a delivery", async () => {
    const order = await pickedUpOrder();
    const res = await driver(`/v1/driver/orders/${order.id}/handover`);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("ORDER_INVALID_TRANSITION");
  });

  it("writes a status event for each leg", async () => {
    const order = await pickedUpOrder();
    await driver(`/v1/driver/orders/${order.id}/return`, {
      reason: "customer_absent",
    });
    await driver(`/v1/driver/orders/${order.id}/handover`);

    const events = await db("order_status_events")
      .where({ order_id: order.id })
      .orderBy("occurred_at", "asc");

    expect(events.map((e) => e.status)).toEqual([
      "scheduled",
      "in_pharmacy",
      "picked_up",
      "returned",
      "returned_to_pharmacy",
    ]);
  });

  it("counts the packages the driver still owes the pharmacy", async () => {
    const order = await pickedUpOrder({
      packages: [{ label_code: "A-1" }, { label_code: "A-2" }],
    });
    await driver(`/v1/driver/orders/${order.id}/return`, {
      reason: "customer_absent",
    });

    const queue = (
      await driver(`/v1/driver/queue?date=${DATE}`, undefined, "GET")
    ).json();

    expect(queue.totals.packages_to_return).toBe(2);
    // The label codes stay: the driver has to hand the right bags over, and a
    // bag number is not information about a person.
    expect(
      queue.to_return[0].packages.map((p: { label_code: string }) => p.label_code),
    ).toEqual(["A-1", "A-2"]);
  });
});

describe("completing without collecting the money", () => {
  it("records the pharmacy's authorization to hand it over anyway", async () => {
    // "Si le client n'a pas la possibilité de payer, le livreur doit appeler la
    // pharmacie et demander quoi faire (rapporter la commande ou donner
    // gratuitement)." This is the second branch of that call.
    const order = await pickedUpOrder({ amount_due: 25 });

    const res = await driver(`/v1/driver/orders/${order.id}/complete`, {
      payment_exception: "waived_by_pharmacy",
      payment_exception_note: "Approved by Sylvie on the phone",
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("completed");

    const row = await db("orders").where({ id: order.id }).first();
    expect(row.payment_exception).toBe("waived_by_pharmacy");
    expect(row.payment_exception_note).toBe("Approved by Sylvie on the phone");
    // The money is still owed as a fact; nothing was collected.
    expect(row.payment_collected).toBe(false);
    expect(row.payment_status).toBe("unpaid");
    expect(row.amount_due).toBe(25);
  });

  it("refuses a payment and a waiver in the same breath", async () => {
    const order = await pickedUpOrder({ amount_due: 25 });
    const res = await driver(`/v1/driver/orders/${order.id}/complete`, {
      payment: { payment_method: "cash", amount_collected: 25 },
      payment_exception: "waived_by_pharmacy",
    });

    // Money either changed hands or it did not.
    expect(res.statusCode).toBe(400);
  });

  it("refuses a note with no exception to explain", async () => {
    const order = await pickedUpOrder({ amount_due: 25 });
    const res = await driver(`/v1/driver/orders/${order.id}/complete`, {
      payment_exception_note: "dangling",
    });
    expect(res.statusCode).toBe(400);
  });
});
