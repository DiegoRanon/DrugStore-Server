import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { closeDb, db } from "../../src/db/knex.js";
import { closeRedis, redis } from "../../src/db/redis.js";
import {
  createTestApp,
  createWorld,
  request,
  TEST_PASSWORD,
  type TestWorld,
} from "../helpers/fixtures.js";

/**
 * The session layer the admin dashboard depends on (PRD §4.2).
 *
 * Refresh rotation with reuse detection is the part worth real coverage: a
 * browser client refreshes constantly, and a bug that revokes a family too
 * eagerly logs everyone out while one that never revokes leaves a stolen
 * token usable for a month.
 */

let app: FastifyInstance;
let world: TestWorld;

const ADMIN_EMAIL = "admin@alpha.test";

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
  // Login throttling lives in Redis and would otherwise leak between cases.
  await redis.flushdb();
});

function login(email = ADMIN_EMAIL, password = TEST_PASSWORD) {
  return request(app, {
    method: "POST",
    url: "/v1/auth/login",
    payload: { email, password },
  });
}

function refresh(token: string) {
  return request(app, {
    method: "POST",
    url: "/v1/auth/refresh",
    payload: { refresh_token: token },
  });
}

describe("POST /v1/auth/login", () => {
  it("issues a session for valid credentials", async () => {
    const res = await login();
    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(body.access_token).toBeTruthy();
    expect(body.refresh_token).toBeTruthy();
    expect(body.expires_in).toBeGreaterThan(0);
    expect(body.user.email).toBe(ADMIN_EMAIL);
    expect(body.user.role).toBe("admin");
    expect(body.user.organization_id).toBe(world.orgA.id);
  });

  it("accepts a differently-cased email", async () => {
    const res = await login("ADMIN@ALPHA.TEST");
    expect(res.statusCode).toBe(200);
  });

  it("never returns the password hash", async () => {
    const res = await login();
    expect(JSON.stringify(res.json())).not.toContain("password_hash");
  });

  it("gives the same answer for a wrong password and an unknown email", async () => {
    // Both must be INVALID_CREDENTIALS, or the response becomes an oracle for
    // which email addresses are registered.
    const wrongPassword = await login(ADMIN_EMAIL, "WrongPassword123!");
    const unknownEmail = await login("nobody@alpha.test", TEST_PASSWORD);

    expect(wrongPassword.statusCode).toBe(401);
    expect(unknownEmail.statusCode).toBe(401);
    expect(wrongPassword.json().error.code).toBe("INVALID_CREDENTIALS");
    expect(unknownEmail.json().error.code).toBe("INVALID_CREDENTIALS");
  });

  it("refuses a deactivated account", async () => {
    await db("users").where({ id: world.orgA.adminId }).update({
      is_active: false,
    });

    const res = await login();
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("ACCOUNT_DISABLED");
  });

  it("throttles repeated failures", async () => {
    for (let i = 0; i < 5; i += 1) {
      const res = await login(ADMIN_EMAIL, "WrongPassword123!");
      expect(res.statusCode).toBe(401);
    }

    const throttled = await login(ADMIN_EMAIL, "WrongPassword123!");
    expect(throttled.statusCode).toBe(429);
    expect(throttled.json().error.code).toBe("LOGIN_THROTTLED");
    expect(
      throttled.json().error.details.retry_after_seconds,
    ).toBeGreaterThan(0);
  });

  it("throttles the correct password too once the limit is hit", async () => {
    // Otherwise an attacker who guesses right on attempt 6 walks straight in.
    for (let i = 0; i < 5; i += 1) {
      await login(ADMIN_EMAIL, "WrongPassword123!");
    }

    const res = await login();
    expect(res.statusCode).toBe(429);
  });
});

describe("POST /v1/auth/refresh", () => {
  it("rotates the token and returns a new pair", async () => {
    const session = await login();
    const original = session.json().refresh_token;

    const res = await refresh(original);
    expect(res.statusCode).toBe(200);

    const rotated = res.json().refresh_token;
    expect(rotated).not.toBe(original);
    expect(res.json().access_token).toBeTruthy();
  });

  it("invalidates the old token once rotated", async () => {
    const session = await login();
    const original = session.json().refresh_token;
    await refresh(original);

    const replay = await refresh(original);
    expect(replay.statusCode).toBe(401);
  });

  it("revokes the whole family when a rotated token is replayed", async () => {
    // Replay means the token leaked or the client is broken. Neither case
    // should leave the chain usable.
    const session = await login();
    const first = session.json().refresh_token;

    const second = (await refresh(first)).json().refresh_token;
    const third = (await refresh(second)).json().refresh_token;

    // Replaying the first, already-rotated token.
    const replay = await refresh(first);
    expect(replay.statusCode).toBe(401);

    // The still-current token must now be dead as well.
    const afterBreach = await refresh(third);
    expect(afterBreach.statusCode).toBe(401);

    const rows = await db("refresh_tokens").where({
      user_id: world.orgA.adminId,
    });
    expect(rows.every((r) => r.revoked_at !== null)).toBe(true);
    expect(
      rows.some((r) => r.revoked_reason === "reuse_detected"),
    ).toBe(true);
  });

  it("stores only a hash, never the token itself", async () => {
    const session = await login();
    const token = session.json().refresh_token;

    const rows = await db("refresh_tokens").where({
      user_id: world.orgA.adminId,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.token_hash).not.toBe(token);
    expect(rows[0]!.token_hash).toHaveLength(64);
  });

  it("refuses a garbage token", async () => {
    const res = await refresh("not-a-real-token");
    expect(res.statusCode).toBe(401);
  });

  it("refuses an expired token", async () => {
    const session = await login();
    await db("refresh_tokens")
      .where({ user_id: world.orgA.adminId })
      .update({ expires_at: new Date(Date.now() - 1000) });

    const res = await refresh(session.json().refresh_token);
    expect(res.statusCode).toBe(401);
  });
});

describe("POST /v1/auth/logout", () => {
  it("revokes the presented token", async () => {
    const session = await login();
    const token = session.json().refresh_token;

    const res = await request(app, {
      method: "POST",
      url: "/v1/auth/logout",
      payload: { refresh_token: token },
    });
    expect(res.statusCode).toBe(204);

    expect((await refresh(token)).statusCode).toBe(401);
  });

  it("is silent about an unknown token", async () => {
    const res = await request(app, {
      method: "POST",
      url: "/v1/auth/logout",
      payload: { refresh_token: "never-existed" },
    });
    expect(res.statusCode).toBe(204);
  });
});

describe("GET /v1/auth/me", () => {
  it("returns the user and their organization", async () => {
    const res = await request(app, {
      method: "GET",
      url: "/v1/auth/me",
      token: world.orgA.adminToken,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.user.id).toBe(world.orgA.adminId);
    expect(body.organization.id).toBe(world.orgA.id);
    expect(body.organization.timezone).toBeTruthy();
    expect(body.organization.locale).toBeTruthy();
  });

  it("refuses a request with no token", async () => {
    const res = await request(app, { method: "GET", url: "/v1/auth/me" });
    expect(res.statusCode).toBe(401);
  });

  it("refuses a token signed with the wrong secret", async () => {
    const res = await request(app, {
      method: "GET",
      url: "/v1/auth/me",
      token: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.invalidsignature",
    });
    expect(res.statusCode).toBe(401);
  });

  it("refuses a token missing the org claim", async () => {
    // The data layer cannot scope a query without it, so it must be rejected
    // at the edge rather than defaulted.
    const token = app.jwt.sign({ sub: world.orgA.adminId, role: "admin" });
    const res = await request(app, {
      method: "GET",
      url: "/v1/auth/me",
      token,
    });

    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("UNAUTHENTICATED");
  });
});

describe("POST /v1/auth/password/change", () => {
  it("changes the password and revokes every other session", async () => {
    const session = await login();
    const staleRefresh = session.json().refresh_token;
    const accessToken = session.json().access_token;

    const res = await request(app, {
      method: "POST",
      url: "/v1/auth/password/change",
      token: accessToken,
      payload: {
        current_password: TEST_PASSWORD,
        new_password: "BrandNewPassword456!",
      },
    });
    expect(res.statusCode).toBe(204);

    expect((await refresh(staleRefresh)).statusCode).toBe(401);
    expect((await login()).statusCode).toBe(401);
    expect(
      (await login(ADMIN_EMAIL, "BrandNewPassword456!")).statusCode,
    ).toBe(200);
  });

  it("refuses when the current password is wrong", async () => {
    const res = await request(app, {
      method: "POST",
      url: "/v1/auth/password/change",
      token: world.orgA.adminToken,
      payload: {
        current_password: "NotMyPassword123!",
        new_password: "BrandNewPassword456!",
      },
    });

    expect(res.statusCode).toBe(401);
  });

  it("refuses a password shorter than the 12-character minimum", async () => {
    const res = await request(app, {
      method: "POST",
      url: "/v1/auth/password/change",
      token: world.orgA.adminToken,
      payload: { current_password: TEST_PASSWORD, new_password: "short" },
    });

    expect(res.statusCode).toBe(400);
  });
});

describe("POST /v1/auth/register/driver", () => {
  async function createInvite(): Promise<string> {
    const res = await request(app, {
      method: "POST",
      url: "/v1/invites",
      token: world.orgA.adminToken,
      payload: {},
    });
    return res.json().code;
  }

  const newDriver = {
    email: "newhire@alpha.test",
    password: "NewDriverPass123!",
    first_name: "New",
    last_name: "Hire",
  };

  it("registers a driver into the invite's organization", async () => {
    const code = await createInvite();

    const res = await request(app, {
      method: "POST",
      url: "/v1/auth/register/driver",
      payload: { code, ...newDriver },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().organization_id).toBe(world.orgA.id);

    const row = await db("users").where({ email: newDriver.email }).first();
    expect(row.role).toBe("driver");
    expect(row.organization_id).toBe(world.orgA.id);
  });

  it("appears immediately on the admin roster", async () => {
    // The registration → roster handoff the dashboard's driver page depends on.
    const code = await createInvite();
    await request(app, {
      method: "POST",
      url: "/v1/auth/register/driver",
      payload: { code, ...newDriver },
    });

    const roster = await request(app, {
      method: "GET",
      url: "/v1/drivers?search=Hire",
      token: world.orgA.adminToken,
    });

    const rows = roster.json().data as { email: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.email).toBe(newDriver.email);
  });

  it("refuses a code that was already redeemed", async () => {
    const code = await createInvite();
    await request(app, {
      method: "POST",
      url: "/v1/auth/register/driver",
      payload: { code, ...newDriver },
    });

    const res = await request(app, {
      method: "POST",
      url: "/v1/auth/register/driver",
      payload: { code, ...newDriver, email: "second@alpha.test" },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("INVITE_CODE_REDEEMED");
  });

  it("refuses an unknown code", async () => {
    const res = await request(app, {
      method: "POST",
      url: "/v1/auth/register/driver",
      payload: { code: "ZZZZZZZZ", ...newDriver },
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("INVITE_CODE_INVALID");
  });

  it("refuses an expired code", async () => {
    const code = await createInvite();
    await db("invite_codes")
      .where({ code })
      .update({ expires_at: new Date(Date.now() - 1000) });

    const res = await request(app, {
      method: "POST",
      url: "/v1/auth/register/driver",
      payload: { code, ...newDriver },
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("INVITE_CODE_EXPIRED");
  });

  it("refuses an email already registered", async () => {
    const code = await createInvite();

    const res = await request(app, {
      method: "POST",
      url: "/v1/auth/register/driver",
      payload: { code, ...newDriver, email: ADMIN_EMAIL },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("EMAIL_ALREADY_REGISTERED");
  });
});
