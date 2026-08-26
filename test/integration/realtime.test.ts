import type { AddressInfo } from "node:net";

import type { FastifyInstance } from "fastify";
import { io as ioClient, type Socket } from "socket.io-client";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import { closeDb, db } from "../../src/db/knex.js";
import { closeRedis } from "../../src/db/redis.js";
import { getRealtime, setRealtime } from "../../src/realtime/index.js";
import { REALTIME_PATH } from "../../src/realtime/server.js";
import {
  createTestApp,
  createWorld,
  markReady,
  request,
  type TestWorld,
} from "../helpers/fixtures.js";

/**
 * The live channel behind "the driver should not have to reload the app".
 *
 * Unlike every other integration file this one needs a real listening server:
 * `app.inject` has no socket, so a WebSocket cannot be injected into it.
 *
 * The assertions that matter most are the negative ones. A frame carrying a
 * patient name would be a second egress path around the driver serializer —
 * the thing docs/privacy-rules.md exists to prevent — and a frame reaching the
 * wrong driver would break PRD §4.4 isolation on a channel that has no
 * repository predicate to fall back on.
 */

let app: FastifyInstance;
let world: TestWorld;
let baseUrl: string;

const DATE = "2026-09-25";

/** Frames arrive over a real socket; nothing may wait forever. */
const FRAME_TIMEOUT_MS = 4000;

beforeAll(async () => {
  app = await createTestApp();
  await app.listen({ port: 0, host: "127.0.0.1" });
  const { port } = app.server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await app.close();
  await closeDb();
  await closeRedis();
});

beforeEach(async () => {
  world = await createWorld(app);
});

const open: Socket[] = [];

afterEach(() => {
  for (const socket of open.splice(0)) socket.close();
});

function connect(token?: string): Socket {
  const socket = ioClient(baseUrl, {
    path: REALTIME_PATH,
    transports: ["websocket"],
    auth: token ? { token } : {},
    // A refused handshake must fail the test, not retry behind its back.
    reconnection: false,
  });
  open.push(socket);
  return socket;
}

/** Resolves on connect, rejects on refusal — so a test can assert either. */
function connected(socket: Socket): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("timed out waiting to connect")),
      FRAME_TIMEOUT_MS,
    );
    socket.on("connect", () => {
      clearTimeout(timer);
      resolve();
    });
    socket.on("connect_error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function nextFrame(
  socket: Socket,
  event: string,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timed out waiting for ${event}`)),
      FRAME_TIMEOUT_MS,
    );
    socket.once(event, (payload: Record<string, unknown>) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

/** Nothing should arrive. Resolves to the frame if one wrongly does. */
function noFrameWithin(
  socket: Socket,
  event: string,
  ms: number,
): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    socket.once(event, (payload: Record<string, unknown>) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

async function createOrder(
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const res = await request(app, {
    method: "POST",
    url: "/v1/orders",
    token: world.orgA.adminToken,
    payload: {
      client_id: world.orgA.clientId,
      delivery_date: DATE,
      delivery_window: "AM",
      ...overrides,
    },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

/** An order on the counter — the only state where assignment notifies. */
async function createReadyOrder(): Promise<string> {
  const orderId = await createOrder();
  await markReady(app, world.orgA.adminToken, orderId);
  return orderId;
}

function assign(orderId: string, driverId: string | null) {
  return request(app, {
    method: "POST",
    url: `/v1/orders/${orderId}/assign`,
    token: world.orgA.adminToken,
    payload: { driver_id: driverId },
  });
}

/** A colleague at the same pharmacy — the isolation case an org filter misses. */
async function secondDriverToken(): Promise<string> {
  const [row] = await db("users")
    .insert({
      organization_id: world.orgA.id,
      role: "driver",
      email: "second-driver@alpha.test",
      password_hash: "unused-for-a-signed-token",
      first_name: "Second",
      last_name: "Driver",
    })
    .returning(["id"]);

  return app.jwt.sign({
    sub: row.id,
    role: "driver",
    org_id: world.orgA.id,
  });
}

describe("handshake", () => {
  it("refuses a connection with no token", async () => {
    await expect(connected(connect())).rejects.toThrow();
  });

  it("refuses a forged token", async () => {
    await expect(connected(connect("not-a-jwt"))).rejects.toThrow();
  });

  it("accepts a valid driver access token", async () => {
    await expect(
      connected(connect(world.orgA.driverToken)),
    ).resolves.toBeUndefined();
  });
});

describe("assignment", () => {
  it("pushes order.assigned to the driver who was assigned", async () => {
    const socket = connect(world.orgA.driverToken);
    await connected(socket);

    const orderId = await createReadyOrder();
    const frame = nextFrame(socket, "order.assigned");

    const res = await assign(orderId, world.orgA.driverId);
    expect(res.statusCode).toBe(200);

    await expect(frame).resolves.toMatchObject({
      order_id: orderId,
      delivery_date: DATE,
      status: "in_pharmacy",
    });
  });

  it("carries no patient information", async () => {
    const socket = connect(world.orgA.driverToken);
    await connected(socket);

    const orderId = await createReadyOrder();
    const frame = nextFrame(socket, "order.assigned");
    await assign(orderId, world.orgA.driverId);

    const payload = await frame;

    // The exact key set, not a spot check: adding a field has to be a
    // deliberate edit to this test, which is where the privacy argument lives.
    expect(Object.keys(payload).sort()).toEqual([
      "delivery_date",
      "order_id",
      "status",
    ]);

    // And nothing patient-shaped anywhere in the frame, whatever it was named.
    // These are the values createWorld seeds onto the client row.
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain("Patient");
    expect(serialized).not.toContain("Street");
    expect(serialized).not.toContain("5145550111");
  });

  it("pushes order.unassigned when the driver is pulled off", async () => {
    const socket = connect(world.orgA.driverToken);
    await connected(socket);

    const orderId = await createReadyOrder();
    await assign(orderId, world.orgA.driverId);

    const frame = nextFrame(socket, "order.unassigned");
    const res = await assign(orderId, null);
    expect(res.statusCode).toBe(200);

    await expect(frame).resolves.toMatchObject({ order_id: orderId });
  });

  it("pushes order.ready when a pre-assigned order reaches the counter", async () => {
    const socket = connect(world.orgA.driverToken);
    await connected(socket);

    const orderId = await createOrder({ driver_id: world.orgA.driverId });

    const frame = nextFrame(socket, "order.ready");
    await markReady(app, world.orgA.adminToken, orderId);

    await expect(frame).resolves.toMatchObject({
      order_id: orderId,
      status: "in_pharmacy",
    });
  });

  it("stays silent when a scheduled order is assigned", async () => {
    const socket = connect(world.orgA.driverToken);
    await connected(socket);

    // Deliberate, and unchanged by the realtime layer: the calendar belongs to
    // the admin until staff declare the order ready, and a reassignment inside
    // it is dispatch housekeeping rather than something the driver acts on.
    const orderId = await createOrder();
    const silent = noFrameWithin(socket, "order.assigned", 1000);
    await assign(orderId, world.orgA.driverId);

    await expect(silent).resolves.toBeNull();
  });
});

describe("a broken realtime layer", () => {
  /*
    The property that lets the publish sit inside NotificationsService.emit at
    all. A dispatcher's assignment is the pharmacy's actual work; a live nudge
    about it is a courtesy. Redis being down must cost the driver one poll
    interval, never cost the pharmacy the assignment.
  */
  it("does not fail the assignment when publishing throws", async () => {
    const working = getRealtime();
    setRealtime({
      toDriver() {
        throw new Error("redis is down");
      },
    });

    try {
      const orderId = await createReadyOrder();
      const res = await assign(orderId, world.orgA.driverId);
      expect(res.statusCode).toBe(200);
      expect(res.json().driver_id).toBe(world.orgA.driverId);

      // And the durable half still landed, so the driver finds it in the feed
      // whether or not the frame ever went out.
      const feed = await request(app, {
        method: "GET",
        url: "/v1/driver/notifications",
        token: world.orgA.driverToken,
      });
      expect(feed.statusCode).toBe(200);
      expect(feed.json().data[0]).toMatchObject({
        order_id: orderId,
        type: "order_assigned",
      });
    } finally {
      setRealtime(working);
    }
  });
});

describe("isolation", () => {
  it("does not deliver an assignment to a driver at another pharmacy", async () => {
    const other = connect(world.orgB.driverToken);
    await connected(other);

    const mine = connect(world.orgA.driverToken);
    await connected(mine);

    const orderId = await createReadyOrder();
    const delivered = nextFrame(mine, "order.assigned");
    const leaked = noFrameWithin(other, "order.assigned", 1500);

    await assign(orderId, world.orgA.driverId);

    // Await the frame that *should* arrive first, so the negative assertion is
    // not merely observing that the server was slow.
    await delivered;
    await expect(leaked).resolves.toBeNull();
  });

  it("does not deliver an assignment to a colleague at the same pharmacy", async () => {
    // The case a per-organization room would get wrong: same org, wrong driver.
    const colleague = connect(await secondDriverToken());
    await connected(colleague);

    const mine = connect(world.orgA.driverToken);
    await connected(mine);

    const orderId = await createReadyOrder();
    const delivered = nextFrame(mine, "order.assigned");
    const leaked = noFrameWithin(colleague, "order.assigned", 1500);

    await assign(orderId, world.orgA.driverId);

    await delivered;
    await expect(leaked).resolves.toBeNull();
  });
});
