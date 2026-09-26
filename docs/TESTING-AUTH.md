# Testing Phase 2 — Authentication

How to verify the auth layer by hand. Covers PRD §4 (login, roles, invite codes, org isolation) and the §3 API conventions.

---

## 1. Start the stack

```bash
docker compose up -d      # Postgres on host port 5433, Redis on 6379
npm run migrate           # base schema + migrations 002–009
npm run seed              # two organizations with admins, drivers, clients
npm run dev               # API on http://localhost:3000
```

`npm run migrate:status` shows what has been applied. Re-running `seed` is safe — it is idempotent.

> **Port note:** Postgres is published on **5433**, not 5432, because another local container already owns 5432.

---

## 2. The fast way

```bash
npm run verify:auth
```

41 black-box checks against the running server: provisioning, login, `/me`, invite lifecycle, driver registration, role enforcement, refresh rotation with reuse detection, logout, password change, error-envelope conventions, and the failed-login throttle. Exits non-zero if anything fails.

Against another environment:

```bash
BASE_URL=https://staging.example.ca npm run verify:auth -- --no-reset
```

`--no-reset` stops the script clearing Redis throttle counters — always use it anywhere you should not be flushing keys. Locally, leave it off so the script is re-runnable.

---

## 3. Seeded accounts

All use the password `DevPassword123!`.

| Email | Role | Organization |
| --- | --- | --- |
| `admin@stlaurent.example.ca` | admin | Pharmacie Saint-Laurent |
| `driver@stlaurent.example.ca` | driver | Pharmacie Saint-Laurent |
| `admin@riverside.example.ca` | admin | Riverside Medibus |
| `driver@riverside.example.ca` | driver | Riverside Medibus |

Two organizations exist on purpose: isolation is the invariant most worth checking, and it cannot be checked against a single tenant.

---

## 4. Manual walkthrough

Git Bash / macOS / Linux. For PowerShell see §6.

### 4.1 Create an organization and its first admin

Nothing in the public API creates an organization — that would let anyone mint tenants. It lives behind a static service token instead (`INTERNAL_API_TOKEN` in `.env`).

```bash
curl -s -X POST http://localhost:3000/v1/internal/organizations \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer local-development-internal-token' \
  -d '{
    "name": "Pharmacie Test",
    "phone": "+15145550000",
    "locale": "fr",
    "delivery_rate": 7.50,
    "admin": {
      "email": "admin@test.example.ca",
      "password": "TestPassword123!",
      "first_name": "Ada",
      "last_name": "Lovelace"
    }
  }'
```

**Expect 201** with the organization and admin IDs. Drop the `authorization` header and you get **401**.

### 4.2 Log in

One endpoint for both roles — the server reads the role off the user record and returns it so the client knows which interface to open.

```bash
curl -s -X POST http://localhost:3000/v1/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"admin@stlaurent.example.ca","password":"DevPassword123!"}'
```

**Expect 200** with `access_token`, `refresh_token`, `expires_in: 900`, and a `user` object containing `role` and `organization_id`.

Save the tokens:

```bash
TOKEN=$(curl -s -X POST http://localhost:3000/v1/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"admin@stlaurent.example.ca","password":"DevPassword123!"}' \
  | node -pe 'JSON.parse(require("fs").readFileSync(0)).access_token')
```

Try a wrong password, and then an email that does not exist. **Both return the identical `401 INVALID_CREDENTIALS`** — that is deliberate, so the endpoint cannot be used to discover which addresses are registered.

### 4.3 Current user

```bash
curl -s http://localhost:3000/v1/auth/me -H "authorization: Bearer $TOKEN"
```

**Expect 200** with the user and their organization (name, timezone, locale). No token → **401**.

### 4.4 Invite a driver

```bash
curl -s -X POST http://localhost:3000/v1/invites \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{}'
```

**Expect 201** with an 8-character code. The alphabet omits `I`, `O`, `0` and `1` — drivers type these off a printed sheet, and those are the glyphs that generate support calls.

Optional expiry: `-d '{"expires_at":"2026-12-31T23:59:59Z"}'`.

### 4.5 Register a driver with the code

```bash
curl -s -X POST http://localhost:3000/v1/auth/register/driver \
  -H 'content-type: application/json' \
  -d '{
    "code": "PASTE_CODE_HERE",
    "email": "newdriver@test.example.ca",
    "password": "DriverPassword123!",
    "first_name": "Nouveau",
    "last_name": "Livreur"
  }'
```

**Expect 201.** The driver's organization comes from the code, never from the request body.

Now run the exact same command again — **expect `409 INVITE_CODE_REDEEMED`**. Codes are single-use, enforced by a conditional `UPDATE` inside the registration transaction, so two people submitting the same code simultaneously cannot both succeed.

A code that does not exist gives **`422 INVITE_CODE_INVALID`**.

### 4.6 Roles are enforced server-side

Log in as the driver you just created, then try to generate an invite code with their token:

```bash
curl -s -X POST http://localhost:3000/v1/invites \
  -H "authorization: Bearer $DRIVER_TOKEN" \
  -H 'content-type: application/json' -d '{}'
```

**Expect `403 FORBIDDEN`.**

### 4.7 Organization isolation

This is the one worth checking carefully. Log in as **both** admins, then list invites with each token:

```bash
curl -s http://localhost:3000/v1/invites -H "authorization: Bearer $TOKEN_STLAURENT"
curl -s http://localhost:3000/v1/invites -H "authorization: Bearer $TOKEN_RIVERSIDE"
```

Each sees only its own codes. Now take a code `id` belonging to Saint-Laurent and try to delete it with the Riverside token:

```bash
curl -s -X DELETE http://localhost:3000/v1/invites/THAT_ID \
  -H "authorization: Bearer $TOKEN_RIVERSIDE" -i
```

**Expect 404, not 403.** A 403 would confirm the record exists; 404 tells a caller from the wrong organization nothing at all.

The scoping is not written per route — it lives in `OrgScopedRepository` (`src/core/repository.ts`), which applies the organization filter before any query builder reaches a handler, and cannot be constructed without a request context.

### 4.8 Refresh rotation and reuse detection

```bash
curl -s -X POST http://localhost:3000/v1/auth/refresh \
  -H 'content-type: application/json' \
  -d "{\"refresh_token\":\"$REFRESH\"}"
```

**Expect 200 with a _different_ refresh token** — they rotate on every use.

Now send the **old** token again. **Expect `401 INVALID_REFRESH_TOKEN`.** Then try the new one: it is dead too. Presenting a spent token means the chain was either stolen or replayed, and we cannot tell which, so the whole family is revoked and the user must sign in again.

### 4.9 Logout

```bash
curl -s -X POST http://localhost:3000/v1/auth/logout \
  -H 'content-type: application/json' \
  -d "{\"refresh_token\":\"$REFRESH\"}" -i
```

**Expect 204.** The token no longer refreshes. Logging out an unknown token also returns 204 — it is idempotent and must not confirm whether a token was real.

### 4.10 Failed-login throttle

Six wrong passwords for the same email:

```bash
for i in $(seq 1 6); do
  curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:3000/v1/auth/login \
    -H 'content-type: application/json' \
    -d '{"email":"admin@riverside.example.ca","password":"wrong"}'
done
```

**Expect five `401`s then a `429`** carrying `LOGIN_THROTTLED` and `retry_after_seconds`. Backoff doubles with each further failure: 1, 2, 4… minutes, capped at an hour. A successful login clears the counter.

⚠️ A separate per-IP limit of **10 login requests per minute** sits in front of this. From one machine that limit is tighter and will fire first, giving `RATE_LIMITED` instead of `LOGIN_THROTTLED`. To see the per-email control on its own, clear the IP counters first:

```bash
docker exec medibus-redis redis-cli --scan --pattern 'ratelimit:*' \
  | xargs -r docker exec medibus-redis redis-cli DEL
```

---

## 5. Checking the database directly

```bash
docker exec -it medibus-postgres psql -U medibus -d medibus
```

```sql
-- Passwords are Argon2id; no plaintext anywhere
SELECT email, role, left(password_hash, 30) || '…' AS hash FROM users;

-- Refresh tokens are stored hashed, and rotation leaves a revocation trail
SELECT left(token_hash, 12) AS hash, revoked_reason, rotated_from_id IS NOT NULL AS rotated
FROM refresh_tokens ORDER BY created_at DESC LIMIT 10;

-- A redeemed invite records who took it and when
SELECT code, is_active, redeemed_at, redeemed_by_user_id FROM invite_codes;

-- The DB itself refuses a second admin per organization
SELECT organization_id, count(*) FROM users WHERE role = 'admin' GROUP BY 1;
```

---

## 6. PowerShell

`curl` in PowerShell is an alias for `Invoke-WebRequest`, which takes different arguments and will confuse you. Either call `curl.exe` explicitly, or use native cmdlets:

```powershell
$login = Invoke-RestMethod -Method Post -Uri http://localhost:3000/v1/auth/login `
  -ContentType 'application/json' `
  -Body '{"email":"admin@stlaurent.example.ca","password":"DevPassword123!"}'

$headers = @{ authorization = "Bearer $($login.access_token)" }
Invoke-RestMethod -Uri http://localhost:3000/v1/auth/me -Headers $headers
```

`Invoke-RestMethod` throws on 4xx instead of returning the body, so wrap error cases:

```powershell
try   { Invoke-RestMethod -Uri http://localhost:3000/v1/auth/me }
catch { $_.ErrorDetails.Message }
```

---

## 7. Things that will trip you up

| Symptom | Cause |
| --- | --- |
| `429 RATE_LIMITED` on everything | Global limit is 100 req/min per user, 10/min on login. Wait a minute, or clear `ratelimit:*` in Redis. |
| `Body cannot be empty when content-type is set to 'application/json'` | A `DELETE` or `GET` sent with a JSON content-type but no body. Drop the header. |
| `401` right after a successful login | Access tokens last 15 minutes. Use the refresh endpoint. |
| Connection refused on 5432 | Postgres is on **5433** here. |
| `ECONNREFUSED` from the API on boot | Containers not up yet — `docker compose ps` should show both healthy. |
| Seed data missing after `docker compose down -v` | `-v` drops the volume. Re-run `npm run migrate && npm run seed`. |

---

## 8. Related

- [TESTING-ORDERS.md](TESTING-ORDERS.md) — clients, orders, and the state machine (Phase 3)
- [TESTING-DRIVER.md](TESTING-DRIVER.md) — driver queue, transitions, payment, cooler check, idempotency (Phase 4)
- `npm test` — the Vitest suite PRD §10 calls non-negotiable: organization isolation across every authenticated route, the full state-machine matrix, and the driver PII serializers. It runs against its own `medibus_test` database and never touches your development data.
- `npm run verify` — both black-box HTTP suites in one go.
