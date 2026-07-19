# Self-Hosting Guide

This guide is for organizations that want to run their own independent deployment of FloorVote. You will provision your own Cloudflare infrastructure.

Self-hosting means you'll be setting up two things: your own Cloudflare infrastructure to run FloorVote, and an account with a legislative data provider to feed it bills. It's a guided, one-time setup — once it's deployed, running FloorVote day to day doesn't require touching this guide again. The steps below walk through both, in order.

---

## Accounts you'll need

Before you start, set up these two accounts:

- **Cloudflare** — this is where FloorVote itself runs. You'll need the [**Workers Paid**](https://www.cloudflare.com/plans/developer-platform/) plan ($5/month), which is required for Queues (used to move bill updates from the central service out to tenants).
- **LegiScan** — this is where the legislative data comes from. Register for a LegiScan OneVote account [here](https://legiscan.com/user/register), confirm your account, and then generate a free API key [here](https://legiscan.com/legiscan). The free tier is sufficient to start.

> Legiscan provides bill data via their API but is not involved with FloorVote. If you become a free LegiScan user, please do not reach out to them for support with FloorVote.


---

## Choosing a legislative data provider

FloorVote supports two legislative data providers. **LegiScan is the recommended path** — it's more mature, better tested, and powers all production deployments.

| | **LegiScan** (recommended) | **OpenStates** |
|---|---|---|
| API key | Free tier (~30k queries/month) is sufficient | Free; no key required for bulk seeding |
| Coverage | All 50 US states + DC + US Congress | All 50 US states + DC |
| Maturity | Production path; actively maintained | Experimental; less maintained, not at feature parity |
| Bill IDs | Integer IDs (`legiscan:<id>`) | OCD string IDs (`ocd-bill/UUID`) |
| Central env | `legiscan` env (`npm run deploy:legiscan`) | Default env (`npm run deploy`) |
| Admin dashboard | Yes — superadmin observability dashboard | No |

Register for a free LegiScan API key at [legiscan.com/legiscan](https://legiscan.com/legiscan).

> **OpenStates** is available as an alternative but the code path is less actively maintained and lacks some features present in the LegiScan path (admin dashboard, engagement stats, dynamic queue delivery). It may require additional work to reach parity. The rest of this guide documents the LegiScan path; OpenStates differences are noted where relevant.

---

## Architecture overview

```
Legislative API (LegiScan or OpenStates)
      │
      ▼
┌─────────────────────────────┐
│  CENTRAL SERVICE (your own) │
│  Worker + D1 + R2 + Queues  │
│                             │
│  Ingests all bill data,     │
│  stores text in R2,         │
│  notifies tenants           │
└──────────────┬──────────────┘
               │
     ┌─────────┴─────────┐
     ▼                   ▼
┌──────────┐       ┌──────────┐
│ Tenant A │       │ Tenant B │
│ Worker+D1│       │ Worker+D1│
│ e.g. NJ  │       │ National │
└──────────┘       └──────────┘
```

- **Central service** — one per operator. Owns all legislative API calls and bill storage. You pay for one API key regardless of how many tenants you run. AI processing happens tenant-side only.
- **Tenant Workers** — one per organization or topic focus. Each tenant has its own users, votes, comments, positions, and relevance configuration. Tenants never call LegiScan directly.

For a detailed walkthrough of the sync pipeline (cron passes, ingestor behavior, and deduplication), see the [Architecture overview](/architecture/). The full code-grounded pipeline and the interactive `sync-flow.html` companion live in `docs/internal/` in the repository.

---

## Domains and email

Two per-tenant vars (in your `[env.*].vars`, see `api/wrangler.example.toml`) make a
deployment domain-agnostic:

- **`APP_DOMAINS`** — comma-separated registrable domains this deployment serves. It
  drives cross-subdomain CORS and the superadmin SSO cookie scope. Set **one** domain for
  a normal single-host deployment. **Leave it unset** if you serve a single host or a bare
  `*.workers.dev` URL — that yields same-origin-only CORS and a host-only login cookie,
  which is correct for one host. List **two** domains only while migrating from an old
  domain to a new one: serving both lets existing sessions keep working (session cookies are
  host-only, so a redirect would force re-login). Drop back to one after the cutover.
- **`EMAIL_FROM`** — the full sender address for magic-link and notification email, e.g.
  `notifications@example.org`. Sending always requires a **verified** domain (a
  `*.workers.dev` host cannot send), independent of where the app is served. Unset falls
  back to a default sender address. Optional `EMAIL_REPLY_TO` defaults to `EMAIL_FROM`.

See the [Adding tenants](/self-hosting/tenants) guide for a more detailed step-by-step walkthrough.

---

## Prerequisites

- Cloudflare account with Workers, D1, R2, and Queues enabled (Workers Paid plan required for Queues)
- `wrangler` CLI: `npm install -g wrangler` — authenticate via `CLOUDFLARE_API_TOKEN` env var (recommended; doesn't expire) or `wrangler login` (OAuth; expires periodically). Create a token at Cloudflare dashboard → My Profile → API Tokens: start from the "Edit Cloudflare Workers" template, then add **D1: Edit** and **Queues: Edit** (the template omits both) plus, if you'll set up custom domains, your zone's **Workers Routes: Edit** and **DNS: Edit**. See [Deploy API token](/self-hosting/tenants#_2-deploy-api-token-cloudflare-api-token) for the full permission list.
- API keys:
  - **LegiScan** — Free tier (~30k queries/month) is sufficient for a national deployment across all 52 jurisdictions. Register at [legiscan.com/legiscan](https://legiscan.com/legiscan). Pull tier (100k/month) gives extra headroom.
  - *(OpenStates path only)* **OpenStates** — free; no key required for bulk data. For live cron sync, register at [openstates.org/api/register](https://openstates.org/api/register/).
  - **Cloudflare AI Gateway** — Routes Gemini API calls through your Cloudflare account for unified billing and observability. Create a gateway in the Cloudflare dashboard (Workers & Pages → AI Gateway). Gemini 2.5 Flash is cost-effective. Set `AI_GATEWAY_ENABLED=true`, `CF_ACCOUNT_ID`, and `CF_AIG_GATEWAY` on each tenant, plus the `CF_AIG_TOKEN` secret.
  - **Cloudflare Email Service** — For magic link authentication emails. Configure a `[[send_email]]` binding in wrangler.toml. Resend is included as an optional fallback (`EMAIL_PROVIDER=resend`) if you prefer a third-party email provider.

---

## Part 1: Central Service

### 1. Provision Cloudflare resources

Run from the repo root:

```bash
wrangler d1 create central-bills
wrangler r2 bucket create central-bill-texts
wrangler queues create central-legiscan-ingestor
```

Save the `database_id` from the D1 output — you'll need it next.

> **OpenStates path:** name the queue `central-ingestor` instead.

### 2. Configure `central/wrangler.toml`

Copy `central/wrangler.example.toml` to `central/wrangler.toml` and fill in your values. The key settings for a LegiScan deployment:

```toml
[env.legiscan]
name = "floorvote-central-legiscan"
main = "src/index-legiscan.ts"

[env.legiscan.vars]
OPERATOR_NAME = "Your Organization Name"
BILL_PROVIDER = "legiscan"

[[env.legiscan.d1_databases]]
binding = "DB"
database_name = "central-bills"
database_id = "<YOUR_D1_DATABASE_ID>"
migrations_dir = "migrations-legiscan"

[[env.legiscan.r2_buckets]]
binding = "BILLS_BUCKET"
bucket_name = "central-bill-texts"

[[env.legiscan.queues.producers]]
binding = "INGESTOR_QUEUE"
queue = "central-legiscan-ingestor"

[[env.legiscan.queues.consumers]]
queue = "central-legiscan-ingestor"
max_batch_size = 5
max_batch_timeout = 30

[env.legiscan.triggers]
crons = ["0 * * * *"]
```

See `central/wrangler.example.toml` for the complete template including optional bindings.

### Operator branding (sidebar credit + support contact)

All operator branding is optional and configured per deployment — `shared/brand.ts`
holds only the product name. Set these tenant vars in your `wrangler.toml`
`[env.<name>.vars]` block (leave any empty for an unbranded instance):

- `OPERATOR_NAME` — label shown under the footer logo. Empty → no name line.
- `OPERATOR_URL` — link target for the logo/name. Empty → the credit is unlinked.
- `OPERATOR_CONTACT_EMAILS` — comma-separated support address(es), used as the
  feedback recipient and shown in the feedback modal. Empty → feedback is disabled
  and the modal shows no contact link. (Separate from `ALERT_EMAILS`, which is the
  ops/cron-failure pager.)

To show a **logo**, add a file named exactly `web/public/operator-logo.svg` and
rebuild. If the file is absent, no logo renders — the app hides it gracefully (no
broken-image icon); you may see a harmless `404` for `/operator-logo.svg` in the
browser network log, which is expected and safe to ignore.

Each piece (name, link, logo) is independent; an instance with all three unset
shows only the data-source attribution.

### 3. Set central secrets

From inside `central/`:

```bash
wrangler secret put LEGISCAN_API_KEY --env legiscan
wrangler secret put ADMIN_SECRET --env legiscan         # a strong random string — guards admin endpoints
```

Generate a strong `ADMIN_SECRET`:
```bash
openssl rand -base64 32
```

> **OpenStates path:** `wrangler secret put OPENSTATES_API_KEY` (no `--env` flag) instead of `LEGISCAN_API_KEY`.

#### Queue delivery (recommended)

Central delivers bills to each tenant's queue. Unless you add a static `TENANT_QUEUE_<ID>` producer binding for every tenant in `central/wrangler.toml`, central resolves and HTTP-publishes to tenant queues dynamically — which needs **both** a Cloudflare API token scoped **Queues: Edit** and central's `CF_ACCOUNT_ID` **var** (set in `[env.legiscan.vars]`, not a secret — see `wrangler whoami`):

```bash
wrangler secret put CF_QUEUES_TOKEN --env legiscan
```

Without either one, only statically-bound tenants receive bills — a tenant can register cleanly yet never receive a single bill, with no error. Create the token at Cloudflare dashboard → My Profile → API Tokens → Create Custom Token (Queues: Edit).

#### Admin dashboard

The LegiScan central serves a superadmin dashboard with its own magic-link login and cross-domain SSO. To enable it:

```bash
wrangler secret put RESEND_API_KEY --env legiscan              # magic-link email for the admin dashboard
wrangler secret put SUPERADMIN_JWT_PRIVATE_KEY --env legiscan  # ES256 private JWK (JSON string); central is the sole issuer
wrangler secret put SUPERADMIN_EMAILS --env legiscan           # comma-separated superadmin allowlist
```

The matching ES256 **public** JWK is not a secret — it goes in each tenant's `[env.*.vars]` as `SUPERADMIN_JWT_PUBLIC_KEY` (see Part 3 Step 3). Generate an ES256 keypair with any JWK tool; central holds the private half, tenants verify with the public half.

#### Observability (optional)

These power the ops dashboards and the Members "Login activity" panel. Each cleanly no-ops when unset — no crash, the feature simply stays dark.

`CF_ANALYTICS_TOKEN` covers two separate features and needs a permission for each — both can live on the same token:

- **D1 anomaly watch** — needs the `CF_ACCOUNT_ID` **var** (set in `[env.legiscan.vars]`, not a secret) plus **Account → D1: Read**.
- **Login Activity delivery status** — a zone-level lookup, so it needs **Zone → Analytics: Read** on your app's zone, plus the zone's ID in the `CF_FLOORVOTE_ZONE_ID` **var** (also in `[env.legiscan.vars]` — this is the zone ID from the domain's Overview page in the dashboard, not the account ID). Skip this if you don't need delivery-status detail; the token still works for D1 anomaly watch with just the account permission.

```bash
wrangler secret put CF_ANALYTICS_TOKEN --env legiscan  # Cloudflare API token: Account "D1: Read" + Zone "Analytics: Read"
wrangler secret put CF_EMAIL_TOKEN --env legiscan      # Cloudflare API token, scoped: Email Sending: Read
```

### 4. Run migrations and deploy

```bash
cd central
npm install
npm run deploy:legiscan
```

The deploy script runs migrations automatically. The deployed URL will be `https://floorvote-central-legiscan.<your-subdomain>.workers.dev`. Note this — you'll use it as `CENTRAL_API_URL` for tenants.

### 5. Verify

```bash
curl https://floorvote-central-legiscan.<your-subdomain>.workers.dev/api/health
# → {"status":"ok","operator":"Your Organization Name"}
```

---

## Part 2: Seed Historical Data

Before tenants are live, load historical bill data into the central service. Use LegiScan bulk JSON datasets — **zero API calls**.

### Download and seed

Download zip files from [legiscan.com/gaits/datasets](https://legiscan.com/gaits/datasets) (one zip per state/session), extract them, then run:

```bash
# Extract zip (LegiScan zips have a nested state/session/ directory inside)
unzip -q RI_2026-*.zip -d bulkseeds/RI_2026
# Find the parent of the bill/ directory:
find bulkseeds/RI_2026 -name "bill" -type d
# → bulkseeds/RI_2026/RI/2026-2026_Regular_Session/bill
# Use its parent as --from-dir:

npx tsx scripts/seed-legiscan.ts \
  --from-dir bulkseeds/RI_2026/RI/2026-2026_Regular_Session \
  --state RI \
  --session-id 2253 \
  --tenant org-nj \
  --remote
  [--skip-votes]              # skip roll_calls + roll_call_votes entirely (saves time)
  [--individual-votes-only]   # backfill only per-legislator roll_call_votes for an already-seeded session
```

`--tenant` is optional. When provided, the script auto-calls `seed-session` after seeding central, links bills to the tenant, and ensures `state_coverage` includes the new state. Omit `--tenant` to seed central only, then call `seed-session` manually (shown below).

For smaller states you can skip the manual download with `--from-api` (downloads the dataset zip from LegiScan directly), but this OOMs on US-scale (16k+ bills) datasets — use `--from-dir` for those.

**Performance:** ~1,000 bills/min against the remote D1 (batches 30 bills per `wrangler d1 execute` call). A typical state session (500–3,000 bills) seeds in 1–5 minutes.

After seeding all sessions into the central DB, link bills to each tenant and queue them for AI processing:

```bash
# 1. Register tenant with central (sets keywords — must come first)
curl -X POST https://<central-url>/api/tenants/register \
  -H "x-admin-secret: <ADMIN_SECRET>" \
  -H "Content-Type: application/json" \
  -d '{"tenantId":"org-nj","name":"NJ Org","apiUrl":"https://floorvote-org-nj.<your-subdomain>.workers.dev","stateCoverage":["NJ"],"keywords":["election","voter","ballot"]}'

# 2. Seed-session: links bills to tenant, queues keyword matches for text download + AI
curl -X POST "https://<central-url>/api/tenants/seed-session/org-nj?sessionId=<id>" \
  -H "x-admin-secret: <ADMIN_SECRET>"
```

`seed-session` is idempotent — safe to re-run. Non-keyword bills are delivered as metadata-only stubs; keyword-matched bills are queued for full text download and AI processing.

For sessions with more than ~2,000 bills, seed-session paginates automatically. Call it in a loop until `done: true`:

```bash
OFFSET=0
while true; do
  RESP=$(curl -s -X POST "https://<central-url>/api/tenants/seed-session/<tenantId>?sessionId=<id>&offset=$OFFSET&limit=500" \
    -H "x-admin-secret: <ADMIN_SECRET>")
  echo "$RESP"
  DONE=$(echo "$RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('done',''))")
  NEXT=$(echo "$RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('nextOffset') or '')")
  if [ "$DONE" = "True" ] || [ -z "$NEXT" ]; then break; fi
  OFFSET=$NEXT
done
```

> **OpenStates path:** Download bulk JSON from [data.openstates.org](https://data.openstates.org) and use `scripts/openstates/seed-from-bulk.ts` instead. Then trigger AI processing with `POST /admin/notify-unnotified/<tenantId>` on central.

---

## Part 3: Tenant Deployments

Repeat for each tenant (organization or topic focus).

### 1. Provision tenant resources

```bash
wrangler d1 create floorvote-[tenant]
wrangler queues create floorvote-[tenant]-queue
```

Save the `database_id`.

### 2. Register the tenant with central

```bash
curl -X POST https://<central-url>/api/tenants/register \
  -H "x-admin-secret: <ADMIN_SECRET>" \
  -H "Content-Type: application/json" \
  -d '{
    "tenantId": "org-nj",
    "name": "Prairie Policy Alliance",
    "stateCoverage": ["NJ"],
    "keywords": ["election", "voter", "ballot"]
  }'
```

### 3. Configure `api/wrangler.toml`

Add an environment block for this tenant:

```toml
[env.org-nj]
name = "floorvote-org-nj"

[env.org-nj.vars]
APP_URL = "https://floorvote-org-nj.<your-subdomain>.workers.dev"
ASSOCIATION_NAME = "Prairie Policy Alliance"
STATE = "NJ"
CENTRAL_API_URL = "https://floorvote-central-legiscan.<your-subdomain>.workers.dev"
TENANT_ID = "org-nj"
PROVIDER = "legiscan"
AI_GATEWAY_ENABLED = "true"
CF_ACCOUNT_ID = "<YOUR_CLOUDFLARE_ACCOUNT_ID>"
CF_AIG_GATEWAY = "<YOUR_AI_GATEWAY_SLUG>"
INSTANCE_PRESET = "election_officials"   # optional — auto-seeds keywords + AI settings
# Optional — only needed for cross-domain superadmin SSO. ES256 public JWK; must be the
# same public key whose private half is on central (SUPERADMIN_JWT_PRIVATE_KEY). Not a secret.
# SUPERADMIN_JWT_PUBLIC_KEY = '{"kty":"EC","crv":"P-256","x":"...","y":"...","key_ops":["verify"],"ext":true}'

[[env.org-nj.d1_databases]]
binding = "DB"
database_name = "floorvote-org-nj"
database_id = "<TENANT_D1_DATABASE_ID>"
migrations_dir = "migrations"

[[env.org-nj.queues.producers]]
binding = "BILL_QUEUE"
queue = "floorvote-org-nj-queue"

[[env.org-nj.queues.consumers]]
queue = "floorvote-org-nj-queue"
max_batch_size = 10
max_batch_timeout = 30

[[env.org-nj.services]]
binding = "CENTRAL"
service = "floorvote-central-legiscan"
entrypoint = "TenantApi"
```

### 4. Set tenant secrets

From `api/`:

```bash
wrangler secret put CF_AIG_TOKEN --env org-nj            # Cloudflare AI Gateway auth token
wrangler secret put CENTRAL_ADMIN_SECRET --env org-nj    # must match central's ADMIN_SECRET; can be removed after adding a CentralApi service binding
# Optional fallbacks — not read on the happy path:
# wrangler secret put GEMINI_API_KEY --env org-nj        # only if AI_GATEWAY_ENABLED is unset (direct Gemini fallback)
# wrangler secret put RESEND_API_KEY --env org-nj        # only if using Resend instead of Cloudflare Email Service
```

Superadmin SSO is optional. Central holds the `SUPERADMIN_JWT_PRIVATE_KEY` secret and the `SUPERADMIN_EMAILS` allowlist; tenants verify with the `SUPERADMIN_JWT_PUBLIC_KEY` var only. Without it, the tenant has no cross-domain superadmin login.

### 5. Build frontend, run migrations, and deploy tenant

Use the deploy script — never run `wrangler deploy` directly, as it skips migrations and the frontend build:

```bash
# From api/
npm run deploy:tenant -- org-nj
```

This builds the React frontend, applies D1 migrations, and deploys the Worker. The React SPA is served directly by each tenant Worker via Workers Assets — there is no separate Cloudflare Pages project.

### 6. Configure tenant keywords and AI context

After deploying, set tenant-specific configuration via the admin API or directly in D1. The following keys live in the `association_config` table:

| Key | Example |
|-----|---------|
| `keywords` | `["election","voter","ballot","polling","absentee","referendum"]` |
| `ai_context` | `"You are analyzing bills for an association of local election officials who administer elections at the county and municipal level."` |
| `relevance_question` | `"Is this bill relevant to local election administration? Consider direct operational impact, funding, staffing, and legal authority."` |
| `state_coverage` | `["NJ"]` — or `["*"]` for all states, `["*","US"]` for all states + federal |
| `tag_taxonomy` | `["Voter Registration","Ballot Access","Election Funding","Poll Workers","Redistricting","Election Security"]` |

```bash
wrangler d1 execute floorvote-org-nj --remote --env org-nj \
  --command "INSERT INTO association_config (key, value) VALUES
    ('keywords', '[\"election\",\"voter\",\"ballot\",\"polling\",\"absentee\",\"referendum\"]'),
    ('ai_context', 'You are analyzing bills for an association of local election officials.'),
    ('relevance_question', 'Is this bill relevant to local election administration?'),
    ('state_coverage', '[\"NJ\"]')"
```

### 7. Create the founding owner user

There is no self-registration UI. Insert the first user directly — and create them as `owner`, **not** `admin`. Only an owner can grant the owner role to anyone else, so a tenant whose first user is a plain `admin` can never have an owner:

```bash
wrangler d1 execute floorvote-org-nj --remote --env org-nj \
  --command "INSERT INTO users (id, email, name, role) VALUES ('$(uuidgen)', 'owner@example.org', 'Owner Name', 'owner')"
```

The user then logs in via magic link using that email address.

### 8. Verify deployment

Verify at the Worker URL:
```bash
curl https://floorvote-org-nj.<your-subdomain>.workers.dev/api/health
```

To set up a custom domain, add a `routes` entry to the tenant's env block in `api/wrangler.toml`:
```toml
routes = [{ pattern = "nj.yourdomain.com", custom_domain = true }]
```

Then update `APP_URL` to match the custom domain and redeploy.

---

## Public demo site (optional)

Most deployments don't need this — **skip this section and every tenant is a normal, authenticated instance.**

A "demo site" is just a regular tenant deployed with the `DEMO_MODE` var set to `"true"` (in `[env.<id>.vars]` in `api/wrangler.toml`). That one flag turns the tenant into a public, no-signup showcase:

- **Auto-login.** Visitors without a session are silently signed in as a shared demo user — no magic link.
- **Outbound email suppressed.** Digests and notifications are never sent from a demo tenant.
- **Nightly reset.** A 06:00 UTC cron resets and re-seeds the tenant to a known state (`api/src/lib/demoResetAndSeed.ts` is the single source of truth for demo content). You can also trigger it manually with `POST /api/internal/demo-reset`.

To run one, deploy a tenant exactly as in Part 3 with `DEMO_MODE = "true"` added to its vars. To not run one, simply omit the flag — there is no other setup.

### Wiring a demo site into the deploy smoke check

The central deploy ends with an optional post-deploy smoke check (`smoke:legiscan`) that probes the bill-text path end-to-end through the tenant→central binding — the one path that silently 403s if the deny-by-default surface (`central/src/lib/tenantSurface.ts`) is missing an allowlist entry. It's **opt-in via `SMOKE_BASE_URL`**:

- **`SMOKE_BASE_URL` unset (default)** → the check is skipped (exit 0). A deployment without a demo site does not fail its deploy here.
- **`SMOKE_BASE_URL` set to a `DEMO_MODE` tenant** (e.g. inline in the `smoke:legiscan` script or exported by your deploy environment) → the check runs against it. A demo tenant is the easiest target because its shared auto-login session needs no cookie. To probe a non-demo tenant instead, also set `SMOKE_COOKIE` to a valid session cookie.

---

## Login protection: Turnstile (optional)

The unauthenticated login POSTs (`POST /api/auth/magic-link` on each tenant,
`POST /admin/dash/auth/login` on the dashboard) ship with a per-IP rate limiter
that's always on. You can add a [Cloudflare Turnstile](https://developers.cloudflare.com/turnstile/)
human-check on top. It's **off by default and fails open** — skip this section
entirely and login still works.

Turnstile has two halves, both config-driven (no code changes):

1. **Public sitekey** — a `TURNSTILE_SITE_KEY` **var** per worker
   (`[env.<id>.vars]` in `api/wrangler.toml`, `[env.legiscan.vars]` in
   `central/wrangler.toml`). The login form renders the widget **only when this is
   set**; unset → no widget. Served to the form over a public endpoint
   (`GET /auth/demo-mode` on tenants, `GET /admin/dash/auth/config` on the
   dashboard).
2. **Secret key** — the `TURNSTILE_SECRET_KEY` worker **secret**. The server
   verifies the token only when this is set (fails closed: missing/invalid token →
   403); unset → fails open.

Setup:

```bash
# 1. Create a Turnstile widget in the Cloudflare dashboard. List your registrable
#    domain on it (a hostname authorizes all its subdomains) plus `localhost`.
#    Note the sitekey (public) and secret key.

# 2. Add the sitekey var to each worker env that should show the widget, e.g. in
#    api/wrangler.toml:  [env.org-nj.vars]  TURNSTILE_SITE_KEY = "0x...."
#    and central/wrangler.toml: [env.legiscan.vars] TURNSTILE_SITE_KEY = "0x...."

# 3. Set the secret on each worker (tenants from api/, dashboard from central/):
wrangler secret put TURNSTILE_SECRET_KEY --env org-nj
wrangler secret put TURNSTILE_SECRET_KEY --env legiscan   # dashboard
```

**Order matters:** deploy the sitekey-bearing frontend **first** (so the form
sends a token), *then* set the secret — setting the secret first 403s every login
because the gate fails closed before the form is sending tokens. To disable
Turnstile later, delete the secret (`wrangler secret delete TURNSTILE_SECRET_KEY
--env <id>`); the gate reverts to fail-open instantly. Full reference:
`docs/internal/turnstile.md` in the repository.

---

## Ongoing operations

### Adding a new state to an existing tenant

Update `state_coverage` in `association_config`, then trigger a historical load on central for the new state. Central will notify the tenant of any keyword-matching bills.

### Adding a new tenant to your central

1. Provision a new D1 database and queue
2. Register via `POST /api/tenants/register` with your `ADMIN_SECRET`
3. Follow Part 3 above for the new tenant

### Upgrading

Pull the latest code and redeploy. Always use the deploy script to ensure migrations and the frontend build run:

```bash
git pull origin main
cd central && npm install && npm run deploy:legiscan
cd ../api && npm run deploy:tenant -- org-nj   # repeat for each tenant
```

### Monitoring

Each tenant Worker exposes `GET /api/health`. On the LegiScan central, the health check is `GET /api/health` (bare `/health` is served by the admin dashboard SPA). The central worker pulls aggregate engagement stats from each tenant daily at 06:00 UTC.

---

## LegiScan API notes

- **Free tier** (~30k queries/month) is sufficient for a national election-bill deployment across all 52 jurisdictions. Pull tier (100k/month) gives extra headroom.
- **Never bulk-queue bills to the ingestor without `skipFetch: true`** — each ingestor message triggers a `getBill()` API call. For bulk operations use `reprocess` (zero API calls) or `seed-session` (uses `skipFetch: true`).
- Bill data is licensed CC BY 4.0. All UI displaying LegiScan data must include "Data provided by LegiScan" attribution.
- If you plan to charge tenants for platform access, get written confirmation from LegiScan that a central-cache architecture is permitted under your tier's terms.
- **Cloudflare Queue quota:** The Workers free tier allows only 10,000 queue operations/day (~3,333 messages). Bulk seeding a large session (e.g. 10k bills) will exhaust this immediately. Upgrade to Workers Paid ($5/month, 1M ops/month) before running seed-session on large sessions.

## OpenStates (experimental)

OpenStates is supported as an alternative provider but the code path is less actively maintained and not at feature parity with the LegiScan path. If you choose OpenStates:

- Use the default central env (not `legiscan`): set `BILL_PROVIDER = "openstates"` and `PROVIDER = "openstates"` on tenants
- Seed with `scripts/openstates/seed-from-bulk.ts` using bulk JSON from [data.openstates.org](https://data.openstates.org)
- A free API key is sufficient for live cron sync of most single-state deployments; register at [openstates.org/api/register](https://openstates.org/api/register/)
- Bill data is licensed CC BY 4.0 — include attribution in the UI
- The admin dashboard, engagement stats, and dynamic queue delivery are not available on the OpenStates path
