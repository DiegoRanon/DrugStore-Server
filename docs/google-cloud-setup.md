# Getting `GOOGLE_CLOUD_PROJECT_ID` and `GOOGLE_APPLICATION_CREDENTIALS_JSON`

These two values turn on `ROUTE_OPTIMIZER=googlemaps`. Until they exist the
server runs `ROUTE_OPTIMIZER=fake`, which still sequences the queue — it just
sorts by address instead of solving a route.

## First: these are not the Maps API key

The platform talks to two different Google products with two different kinds of
credential. This trips people up, so it is worth being explicit:

| What                 | Product                | Credential            | Env var                                                           |
| -------------------- | ---------------------- | --------------------- | ----------------------------------------------------------------- |
| Address autocomplete | Places API (New)       | A plain API key       | `GOOGLE_MAPS_API_KEY`                                             |
| Stop sequencing      | Route Optimization API | A **service account** | `GOOGLE_CLOUD_PROJECT_ID` + `GOOGLE_APPLICATION_CREDENTIALS_JSON` |

Places is already working on the API key. Route Optimization is a Google **Cloud**
API: it authenticates with OAuth bearer tokens minted from a service account, and
appending `?key=` to it does nothing. That is why it needs its own credential
rather than reusing the one you have.

---

## 1. Get the project ID

In the [Cloud console](https://console.cloud.google.com), pick or create a
project. The **project ID** is the lowercase string on the dashboard — often
something like `drugstore-delivery-481203`, not the display name you typed.

```bash
gcloud projects list
gcloud config set project YOUR_PROJECT_ID
gcloud config get-value project     # this is GOOGLE_CLOUD_PROJECT_ID
```

## 2. Enable billing

Route Optimization will not run on a project without an active billing account.
Link one under **Billing** in the console. There is no free tier to fall back
on, so treat the optimizer as a per-call cost — which is part of why the server
only calls it when someone presses a button, never on a poll.

## 3. Enable the API

```bash
gcloud services enable routeoptimization.googleapis.com --project YOUR_PROJECT_ID
```

Or in the console: **APIs & Services → Enable APIs and Services → Route
Optimization API**.

## 4. Create the service account and grant it a role

```bash
gcloud iam service-accounts create drugstore-route-optimizer \
  --display-name="Drugstore route optimizer" \
  --project YOUR_PROJECT_ID

gcloud projects add-iam-policy-binding drugstore-delivery \
  --member="serviceAccount:drugstore-route-optimizer@YOUR_PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/routeoptimization.editor"
```

`roles/routeoptimization.editor` is the role that permits `OptimizeTours`,
which is the call our adapter makes. `roles/routeoptimization.viewer` also
permits it, so use the viewer role instead if you prefer the tighter grant —
nothing in this codebase writes Route Optimization resources.

## 5. Authenticate — pick one of three

The adapter asks `google-auth-library` for a token. Where that token comes
from is your choice, and **the key file is the least preferred of the three**.

### 5a. No key at all (recommended)

Leave `GOOGLE_APPLICATION_CREDENTIALS_JSON` empty. The client then uses
**Application Default Credentials**, which resolves to:

| Where the server runs | What ADC finds | What you configure |
| --- | --- | --- |
| Cloud Run / GCE / GKE | The attached service account | Attach it. Nothing in `.env`. |
| AWS, or anywhere else | Workload Identity Federation | A federation config, no long-lived key |
| A developer's laptop | Your own gcloud login | `gcloud auth application-default login` |

For local development that is one command:

```bash
gcloud auth application-default login
gcloud auth application-default set-quota-project YOUR_PROJECT_ID
```

Then set `ROUTE_OPTIMIZER=googlemaps` and `GOOGLE_CLOUD_PROJECT_ID`, restart,
and you are done. Your own account needs the same role as step 4 grants the
service account.

Note this runs the optimizer **as you**, which is right for a laptop and wrong
for anything shared.

### 5b. A key, if your org allows it

```bash
gcloud iam service-accounts keys create ./route-optimizer-key.json   --iam-account="drugstore-route-optimizer@YOUR_PROJECT_ID.iam.gserviceaccount.com"
```

If that fails with:

```
FAILED_PRECONDITION: Key creation is not allowed on this service account.
  type: constraints/iam.disableServiceAccountKeyCreation
```

…this is not a problem with your account. An **organization policy** is
blocking key creation for the whole project. Google turns this on by default
for organizations created since 2024, on the reasoning that a long-lived key
in a file is the credential most likely to end up in a git history.

Use 5a instead, or lift the policy — see 5c.

The downloaded file is a credential, not a config file. Do not commit it, and
delete it once its contents are in `.env` or Secrets Manager.

### 5c. Lifting the org policy

Only if you actually want long-lived keys and can grant yourself the rights:

```bash
gcloud resource-manager org-policies disable-enforce   iam.disableServiceAccountKeyCreation --project=YOUR_PROJECT_ID
```

This needs **Organization Policy Administrator** (`roles/orgpolicy.policyAdmin`)
at the *organization*, not the project — Owner does not include it. If you did
not create the organization, you probably cannot do this, and 5a is your path.

## 6. Put the values in `.env`

Only the project id is mandatory:

```ini
ROUTE_OPTIMIZER=googlemaps
GOOGLE_CLOUD_PROJECT_ID=your-project-id
# Leave empty to use Application Default Credentials (5a).
GOOGLE_APPLICATION_CREDENTIALS_JSON=
```

If you did get a key (5b), the server parses it inline at boot, and a `.env`
value cannot span lines — so flatten the JSON onto one line first:

```bash
# Prints the key as a single line, ready to paste after the `=`
node -e "console.log(JSON.stringify(require('./route-optimizer-key.json')))"
```

Boot rejects a key that is not valid JSON with a message saying exactly that,
so a half-pasted multi-line value fails the deploy rather than the first route.

Deployed environments read these from AWS Secrets Manager, like every other
secret here.

---

## Verifying it worked

**The server tells you if the config is wrong before it serves anything.**
`ROUTE_OPTIMIZER=googlemaps` without a project id fails at boot with a named
error rather than at the first driver who taps optimize:

```
Invalid environment configuration:
  GOOGLE_CLOUD_PROJECT_ID: required when ROUTE_OPTIMIZER=googlemaps
```

A credentials problem cannot be caught at boot — ADC is resolved lazily, on the
first call — so it surfaces as `degraded: true` with the reason in the server
log. `Could not load the default credentials` there means ADC found nothing:
run `gcloud auth application-default login`, or attach a service account.

Once it boots, optimize a driver's day from the dashboard's **Itinéraires**
page, or call the endpoint directly:

```bash
curl -X POST http://localhost:3000/v1/orders/route/optimize \
  -H "authorization: Bearer $ADMIN_TOKEN" \
  -H "content-type: application/json" \
  -d '{"date":"2026-09-06","driver_id":"…"}'
```

Read the response:

- `"degraded": false` — Google answered and the sequence is its own.
- `"degraded": true` — the call failed and the **previous order was kept**. This
  is not an error state; a driver holding packages gets a working list either
  way. Check the server log, which records the provider and the reason.
- `"estimates": [...]` present — the distances and times on the driver's cards
  are now real. With the fake optimizer this field is absent entirely, because
  an adapter that cannot measure reports nothing rather than guessing.

If a stop comes back in `unroutable_order_ids`, that is not a credentials
problem: it means the address was never standardized through Places, so it has
no coordinate to route. Those stops are appended to the end of the sequence
rather than dropped, and the fix is to re-pick the address on the order.

## Rolling back

Set `ROUTE_OPTIMIZER=fake` and restart. Nothing else changes — the fake
implements the same port, existing `sequence_number` values stay as they are,
and both the dashboard and the driver app carry on unaware. That is the whole
reason the optimizer sits behind a port.
