# Spinning Up a New Tenant Instance

Each tenant deployment is a single Cloudflare Worker + D1 database + Queue. The Worker serves both the API and the React frontend via Workers Assets — no separate Pages project required. All bill data flows from the shared **central Worker** — tenants never call LegiScan directly. Bill text is stored in central's R2; tenants have no R2 bucket of their own.

Replace `[slug]` with a lowercase identifier (e.g., `org-nj`, `org-ca`) and `[STATE]` with the two-letter abbreviation.

> **Provisioning script.** `scripts/new-instance.sh` automates the steps below end-to-end. It creates the D1 + Queue, appends the env block, deploys the tenant, sets `CF_AIG_TOKEN`, binds `CentralApi` on central and redeploys it, force-registers, optionally seeds history (`--seed-dir`/`--session-id`), and creates the first admin. Use `--from-step N` to resume after a failure. The manual steps below remain the canonical reference and are worth reading before your first run.

> **Renaming resources (forks / rebranding).** The docs and scripts name Workers, D1
> databases, and queues `floorvote-<slug>` by default. If you rebrand — e.g. `acme-<slug>` —
> set **one** value and every derived name follows: `RESOURCE_PREFIX=acme` for the scripts
> (`new-instance.sh`, `teardown-instance.sh`, `deploy.sh`; or drop it in a gitignored
> `scripts/.env.ops`). Critically, set the **matching** `TENANT_QUEUE_PREFIX=acme` var on the
> central Worker (`[env.legiscan.vars]`): central resolves each tenant's delivery queue *by
> name*, so if its prefix doesn't match yours it creates a **phantom queue with no consumer**
> and the tenant silently receives no bills. Keep `RESOURCE_PREFIX` and central's
> `TENANT_QUEUE_PREFIX` in lockstep.

---

## What can and can't be scripted

Almost everything per-tenant is scriptable with `wrangler`: creating the D1 database (Step 1), the Queue (Step 2), running migrations (Step 5), and deploying (Step 6). The Cloudflare **credentials** are not — and they don't need to be, because they are **account-level and created once, then reused by every tenant**:

| Credential | Scriptable? | How it's obtained |
|---|---|---|
| `CF_ACCOUNT_ID` | Read-only | `wrangler whoami`, or dashboard. Same value for every tenant. |
| `CLOUDFLARE_API_TOKEN` (deploy) | **No** — dashboard only | Dashboard → My Profile → API Tokens. One token deploys every tenant. |
| AI Gateway (`CF_AIG_GATEWAY`) | **No** — dashboard only | `wrangler` has no AI Gateway command. Create once; all tenants share it. |
| `CF_AIG_TOKEN` (gateway auth) | **No** — dashboard only | Generated inside the gateway's Settings; account-scoped, so one token serves every tenant. |
| `SUPERADMIN_JWT_PUBLIC_KEY` | n/a (committed var) | The ES256 public JWK, identical on every env — copy from any existing `[env.*]` block. |

So the per-tenant "secret setting" work is small: only `CF_AIG_TOKEN` is strictly required, and you paste the same value you used for the last tenant. See [Generating Cloudflare credentials](#generating-cloudflare-credentials) for the one-time setup.

---

## Generating Cloudflare credentials

Do this **once** for your Cloudflare account. After the initial setup, you reuse the same values for every new tenant.

### 1. Account ID (`CF_ACCOUNT_ID`)

```bash
npx wrangler whoami
```

Copy the account ID from the output (or dashboard → any domain → Overview → right sidebar). It is **not** a secret — it lives in `[env.*.vars]` in `api/wrangler.toml`.

### 2. Deploy API token (`CLOUDFLARE_API_TOKEN`)

Created in the dashboard — **wrangler cannot create API tokens**.

1. Dashboard → **My Profile → API Tokens → Create Token**.
2. Start from the **"Edit Cloudflare Workers"** template, then add two account permissions the template omits: **D1 → Edit** and **Queues → Edit**. The full set you want:
   - **Account** → Workers Scripts: Edit, D1: Edit, Queues: Edit, Workers KV Storage: Edit, Account Settings: Read
   - **Zone** (your app-domain zone(s)) → Workers Routes: Edit, DNS: Edit  *(needed for custom-domain provisioning in Step 10)*
3. Create, copy the token (shown once), and export it in your shell:

```bash
# in ~/.zshrc or ~/.bashrc (tokens don't expire)
export CLOUDFLARE_API_TOKEN="..."
```

One token deploys every tenant. (Alternative: `npx wrangler login` for OAuth, which expires periodically.)

### 3. AI Gateway (`CF_AIG_GATEWAY`)

The gateway is what gives keyless, unified AI billing. **wrangler has no AI Gateway command** — create it in the dashboard or via the REST API.

- **Dashboard:** AI → AI Gateway → **Create Gateway** → name it (e.g. `floorvote`) → Create.
- **API:** `POST https://api.cloudflare.com/client/v4/accounts/{account_id}/ai-gateway/gateways` with a token scoped **AI Gateway: Read + Edit**.

One gateway serves every tenant; the slug goes in `[env.*.vars]` as `CF_AIG_GATEWAY`.

### 4. AI Gateway auth token (`CF_AIG_TOKEN`)

This is the only Cloudflare credential you set as a per-tenant **secret** (with the same value each time).

1. AI → AI Gateway → select your gateway → **Settings**.
2. **Create authentication token** → this generates a token with the **Run** permission. **Copy it now — it is shown only once.**
3. Toggle **Authenticated Gateway** on.

> **Security note:** AI Gateway tokens are **account-scoped** — they cannot be restricted to one gateway, and any token with `AI Gateway Run` can send requests through every gateway on the account. That's acceptable here because all tenants intentionally share the one gateway.

### 5. Superadmin JWT key (`SUPERADMIN_JWT_PUBLIC_KEY`)

Superadmin SSO is ES256: **central is the sole issuer** (holds the private key) and tenants only **verify** with the public key. The public JWK is not a secret — it is committed as a `[env.*.vars]` entry, identical on every env. Copy the exact `SUPERADMIN_JWT_PUBLIC_KEY = '...'` line from any existing tenant block in `api/wrangler.toml`. The private key lives only on central (`SUPERADMIN_JWT_PRIVATE_KEY` secret); you do **not** touch it when adding a tenant.

### Central-side tokens

The steps above cover the **tenant** and **deploy** credentials. The central worker holds its own set of secrets — `CF_QUEUES_TOKEN` (queue delivery), `SUPERADMIN_JWT_PRIVATE_KEY` + `SUPERADMIN_EMAILS` (admin dashboard), and optionally `CF_ANALYTICS_TOKEN` + `CF_EMAIL_TOKEN` (observability). These are set once on central and you don't touch them when adding a tenant. If you're standing up a brand-new central, provision them per [self-hosting.md](self-hosting.md).

---

## Prerequisites

- Cloudflare account with Workers, D1, and Queues enabled
- `wrangler` CLI installed and authenticated (`CLOUDFLARE_API_TOKEN` exported — see above)
- Access to the repo; dependencies installed (`npm install` from repo root, and once in `central/`)
- The LegiScan central Worker is already deployed and running
- The shared Cloudflare credentials from the previous section

---

## Step 1: Create a D1 Database

```bash
npx wrangler d1 create floorvote-[slug]
```

Save the `database_id` from the output.

---

## Step 2: Create a Queue

```bash
npx wrangler queues create floorvote-[slug]-queue
```

---

## Step 3: Add an Environment Block to `api/wrangler.toml`

Copy the `CF_ACCOUNT_ID`, `CF_AIG_GATEWAY`, and `SUPERADMIN_JWT_PUBLIC_KEY` values verbatim from an existing tenant block. See `api/wrangler.example.toml` for a documented template.

**Single-state instance:**

```toml
[env.[slug]]
name = "floorvote-[slug]"
routes = [{ pattern = "[slug].[your-domain]", custom_domain = true }]

[env.[slug].vars]
APP_URL = "https://[slug].[your-domain]"
ASSOCIATION_NAME = "[Full Organization Name]"
OPERATOR_NAME = "Your Operator Name"            # optional — sidebar footer label
OPERATOR_URL = "https://example.org"            # optional — operator link
OPERATOR_CONTACT_EMAILS = "support@example.org" # optional — feedback recipient(s)
INSTANCE_PRESET = "election_officials"           # auto-applied on first register
STATE = "[STATE]"                                # e.g. "NJ"
TENANT_ID = "[slug]"
PROVIDER = "legiscan"
CENTRAL_API_URL = "https://<your-central>.workers.dev"
AI_GATEWAY_ENABLED = "true"
CF_ACCOUNT_ID = "<your-account-id>"
CF_AIG_GATEWAY = "<your-gateway-slug>"
EMAIL_PROVIDER = "cloudflare"
ALERT_EMAILS = "ops@example.org"                 # cron-failure alert recipients
APP_DOMAINS = "[your-domain]"
EMAIL_FROM = "notifications@[your-domain]"
# Copy this exact public JWK from any existing tenant block — identical on every env:
SUPERADMIN_JWT_PUBLIC_KEY = '<your-ES256-public-JWK>'
TURNSTILE_SITE_KEY = "<your-turnstile-site-key>"  # optional; pairs with TURNSTILE_SECRET_KEY

[[env.[slug].d1_databases]]
binding = "DB"
database_name = "floorvote-[slug]"
database_id = "<database-id-from-step-1>"
migrations_dir = "migrations"

[[env.[slug].queues.producers]]
binding = "BILL_QUEUE"
queue = "floorvote-[slug]-queue"

[[env.[slug].queues.consumers]]
queue = "floorvote-[slug]-queue"
max_batch_size = 10
max_batch_timeout = 30
max_concurrency = 3
dead_letter_queue = "floorvote-dlq"

# Login rate limiter — 10 requests per 60s per IP. Each tenant needs a unique
# namespace_id (arbitrary integer, must not collide with other tenants).
[[env.[slug].ratelimits]]
name = "LOGIN_RATE_LIMITER"
namespace_id = "<unique-integer>"
  [env.[slug].ratelimits.simple]
  limit = 10
  period = 60

[[env.[slug].services]]
binding = "CENTRAL"
service = "<your-central-worker-name>"
entrypoint = "TenantApi"

[[env.[slug].send_email]]
name = "EMAIL"

[env.[slug].triggers]
crons = ["0 11 * * *"]   # daily — drives digest emails and week-ahead
```

`APP_DOMAINS` is normally a single domain; list two (comma-separated) only while migrating domains, then drop back to one.

**Multi-state instance:** set `STATE = ""` (the per-state list is stored in `association_config.state_coverage` — see Step 5b):

```toml
[env.[slug].vars]
# ...same as above except:
STATE = ""   # empty for multi-state — state_coverage is seeded in D1 instead
```

The `entrypoint = "TenantApi"` on the `CENTRAL` service binding is what makes outbound tenant→central calls authenticate by *arrival* (the named entrypoint is reachable only over same-account bindings) — the tenant transmits no shared secret outbound.

**Queue delivery — no central change needed.** As long as `CF_QUEUES_TOKEN` (a Queues:Edit token) is set on central, central resolves this tenant's queue at registration, stores its `queue_id`, and HTTP-publishes bills to it. **You do not need to add a `TENANT_QUEUE_` producer binding to `central/wrangler.toml` for delivery.** Add a static producer binding only for a **very high-volume** tenant where you want the binding's `sendBatch(100)` on the hourly cron fan-out instead of HTTP publish:

```toml
# OPTIONAL — high-volume tenants only; requires a central redeploy.
[[env.legiscan.queues.producers]]
binding = "TENANT_QUEUE_[SLUG_UPPERCASED]"   # hyphens → underscores
queue = "floorvote-[slug]-queue"
```

Commit `api/wrangler.toml` before deploying.

---

## Step 4: Set Secrets

> **Deploy first.** `wrangler secret put` attaches a secret to an **already-deployed**
> Worker, so for a brand-new tenant run **Step 6 (deploy) once first**, then set secrets
> and redeploy is not needed (the secret takes effect immediately). `scripts/new-instance.sh`
> does this automatically — it deploys, then sets secrets.

From the `api/` directory. **Only `CF_AIG_TOKEN` is required.**

```bash
npx wrangler secret put CF_AIG_TOKEN --env [slug]      # required — AI Gateway auth (Run); same value every tenant
```

**Optional rollback credentials** — set these only if you want the two fallback levers to work. With the vars above (`AI_GATEWAY_ENABLED="true"`, `EMAIL_PROVIDER="cloudflare"` + the `EMAIL` binding), neither is read on the happy path:

```bash
npx wrangler secret put GEMINI_API_KEY --env [slug]    # optional — only read if AI_GATEWAY_ENABLED is flipped to "false"
npx wrangler secret put RESEND_API_KEY --env [slug]    # optional — only used if EMAIL_PROVIDER="resend" (or the EMAIL binding is absent)
```

- **AI:** when `AI_GATEWAY_ENABLED="true"`, Gemini is reached keylessly through the gateway using `CF_AIG_TOKEN`; `GEMINI_API_KEY` is referenced **only** on the direct-fallback branch.
- **Email:** when `EMAIL_PROVIDER="cloudflare"` and the `[[send_email]]` binding is present, mail goes through Cloudflare Email Service; Resend is the code-level fail-safe.

**Secrets you do not set on a tenant:**

- `CENTRAL_ADMIN_SECRET` — not needed. New tenants use the `CentralApi` RPC binding (Step 6b), so both directions are binding-authenticated. (Still required in `api/.dev.vars` for local dev, which has no service bindings.)
- `SUPERADMIN_EMAILS` — lives only on central.
- `LEGISCAN_API_KEY` — only the central Worker calls LegiScan.

---

## Step 5: Run Migrations

From `api/`:

```bash
npx wrangler d1 migrations apply floorvote-[slug] --remote --env [slug]
```

> **Important:** Always use `migrations apply`, never `d1 execute` with raw SQL files. The `apply` command tracks which migrations have run.

---

## Step 5b: Seed `state_coverage` (multi-state instances only)

For multi-state instances, store the list of tracked states in `association_config`:

```bash
npx wrangler d1 execute floorvote-[slug] --remote --env [slug] \
  --command "INSERT OR REPLACE INTO association_config (key, value) VALUES ('state_coverage', '[\"NJ\",\"RI\",\"WY\",\"WI\"]')"
```

Single-state instances skip this step — the `STATE` env var is sufficient.

---

## Step 6: Deploy the Worker

From `api/`:

```bash
npm run deploy:tenant -- [slug]
```

This builds the frontend, applies pending migrations, and deploys the Worker (including its `CentralApi` entrypoint, which Step 6b binds to). Never run `wrangler deploy --env [slug]` directly — that skips the web build and migrations.

---

## Step 6b: Bind the Tenant on Central (`CentralApi` RPC)

Central→tenant and operator→tenant calls (engagement pull, force-register, run-digest, etc.) run over a per-tenant `CentralApi` RPC binding. Because the tenant worker must exist before central can bind to it, do this **after** the first deploy (Step 6).

1. Add the binding to `central/wrangler.toml` (the name is `TENANT_` + slug uppercased, hyphens → underscores):

```toml
[[env.legiscan.services]]
binding = "TENANT_[SLUG_UPPERCASED]"
service = "floorvote-[slug]"
entrypoint = "CentralApi"
```

2. Deploy central so the binding resolves:

```bash
cd central && npm run deploy:legiscan
```

Once bound, every operator action targets central (which fans out over the binding), and the tenant holds no shared secret.

---

## Step 7: Register the Tenant with Central

This applies `INSTANCE_PRESET` to the tenant's `association_config` (keywords, AI context, taxonomy, relevance question), syncs keywords to central, and registers the tenant's state coverage. Trigger it through central:

```bash
curl -X POST https://<your-central>.workers.dev/api/tenants/[slug]/force-register \
  -H "x-admin-secret: <central ADMIN_SECRET>"
```

(The tenant also self-registers on its daily cron and whenever config is saved in the admin UI — but `force-register` does it immediately.)

Verify:

```bash
curl https://[slug].[your-domain]/api/health   # { "ok": true }
```

---

## When do bills start flowing in?

Registration stores the tenant's keywords + state coverage on central and provisions its queue — but it does **not** itself queue any bills. Delivery is driven by the **central cron** (`0 * * * *`, hourly), and the timing depends on whether central already tracks the tenant's state:

- **State already tracked by another tenant** (its `sessions` rows exist in central): the next **full-sync pass** for that session links the new tenant's bills and queues keyword matches. Full passes run three times a day by default — so within ~10 hours, no seeding required.
- **Brand-new state, not seeded:** central must first *discover* the session, which only happens once per day. Bills then flow on that same pass. Worst case ~24 hours.
- **Want bills immediately:** run the standup seed (Step 8). When central already has the session, `seed-session` links and queues bills right away — no cron wait. For a brand-new state, pass `--seed-dir` to bulk-load central from the LegiScan zip first, then `seed-session` handles the rest.

Non-keyword bills arrive as monitor stubs (keyword/manual-matched bills get full AI; everything else lands as a lightweight stub with no Generate button).

---

## Step 8: Seed the Active Session(s) for Whole-Session Monitoring

> **Customize keywords BEFORE seeding if you can.** Seeding is where central decides which
> bills get full AI (keyword/manual matches) vs. lightweight stubs — using the keywords
> **already synced to central**. If you intend to change the preset's keywords, AI context,
> or taxonomy, do it now (Settings → Configuration, or via `association_config`) and let it
> sync to central **first**, so the initial AI pass uses your final settings. Editing after
> seeding also works, but then you must "Rerun AI on all bills" (Step 12) to regenerate —
> extra time and AI cost.

Every bill in the active session is seeded into the tenant at standup — keyword/manual-matched bills get full AI processing; all others land as lightweight monitor stubs (no Generate button, no AI cost). This means the tenant mirrors the full session from day one.

Two paths depending on whether central already holds the state's bills:

### Path A: Central already has the session (most tenants)

If the state is already tracked by another tenant, central has the sessions and bills in its DB. Paginate `seed-session` per session until `"done": true`:

> **"Active" here includes the current session even if it has adjourned.** Seed the most
> recent regular (and any special) session for the state — a legislature that has gone
> `sine_die` for the cycle is still exactly what a new tenant wants to monitor. Find the
> `session_id`(s) in central's `sessions` table; don't filter on `sine_die = 0`, which
> silently skips a just-adjourned session (and can leave the tenant with zero bills).

```bash
curl -s -X POST \
  "https://<your-central>.workers.dev/api/tenants/seed-session/[slug]?sessionId=[sessionId]&offset=0" \
  -H "x-admin-secret: <central ADMIN_SECRET>"
# advance offset by nextOffset until "done":true
```

Quota-free — no LegiScan API calls. Takes a few minutes for large states (~10,000 bills).

### Path B: Brand-new state (central has no bills yet)

Central must be loaded from the LegiScan bulk zip first; then `seed-session` handles the tenant link.

**1. Download the bulk JSON dataset** from [legiscan.com/gaits/datasets](https://legiscan.com/gaits/datasets). Extract it — you'll get a directory like `RI/2026-2026_Regular_Session/` containing `bill/`, `vote/`, and `people/` subdirectories.

**2. Seed the central DB and link to the tenant** (runs ~1,000 bills/min against remote D1):

```bash
npx tsx scripts/seed-legiscan.ts \
  --from-dir path/to/RI/2026-2026_Regular_Session \
  --state RI \
  --session-id 2253 \
  --tenant [slug] \
  --remote
```

The `--tenant` flag links bills to the tenant and updates its `state_coverage` in one shot — no separate `seed-session` curl needed.

Per-legislator `roll_call_votes` are slow (large states: 20–30 min) and are skipped by default. Pass `--with-individual-votes` to seed them upfront, or backfill later with `--individual-votes-only`. Use `--skip-votes` to skip roll calls entirely.

**Multi-state instances:** run the script once per state/session. Pass `--seed-dir` only for states central hasn't seen; for already-tracked states, `seed-session` (Path A) suffices.

> **LegiScan quota — 30,000 calls/month.** Never bulk-queue bills to the ingestor without `skipFetch: true`. The seeder uses `skipFetch` for keyword matches; safe bulk operations are `reprocess` (zero API calls) and `redownload-texts` (zero API calls).

---

## Step 9: Link Bills to Tenant + Queue AI Processing (optional)

Only needed if you ran Step 8 Path B **without** `--tenant`. This links the seeded bills to the tenant, queues keyword-matching bills through the ingestor (fetches text → stores in R2 → runs AI), and pushes non-keyword bills as monitor stubs:

```bash
curl -X POST "https://<your-central>.workers.dev/api/tenants/seed-session/[slug]?sessionId=[sessionId]" \
  -H "x-admin-secret: <central ADMIN_SECRET>"
```

For sessions with more than 500 bills, paginate: repeat with `&offset=500`, `&offset=1000`, etc. until the response contains `"done": true`.

---

## Step 10: Configure Custom Domain

The custom domain is declared in `api/wrangler.toml` via the `routes` field (Step 3). When you deploy, Cloudflare automatically provisions the custom domain and TLS certificate.

DNS: if your app domain is managed in Cloudflare DNS, no manual record is needed. If using an external domain (e.g. `bills.someorg.com`), add a CNAME pointing the subdomain to `floorvote-[slug].<your-account>.workers.dev`, and update `APP_URL` to match.

---

## Step 11: Create the Founding Owner User

The first user must be created with the `owner` role, **not** `admin`. Only an owner can grant the owner role to anyone else, so a tenant whose first user is a plain `admin` can never have an owner.

```bash
npx wrangler d1 execute floorvote-[slug] --remote --env [slug] \
  --command "INSERT INTO users (id, email, name, role) VALUES ('$(uuidgen)', 'owner@example.com', 'Owner Name', 'owner')"
```

The user can then log in via magic link at the custom domain.

---

## Step 12: Confirm Preset and Configure via Admin UI

Once logged in, go to **Settings → Configuration**.

If you set `INSTANCE_PRESET` in `api/wrangler.toml` (recommended), the worker auto-applies it the first time it registers, so keywords, AI context, taxonomy, and relevance question are already in place. If you didn't, apply a preset now from the dropdown; this seeds those fields, syncs keywords to central, and queues AI for any already-ingested bills missing summaries. See [`docs/presets.md`](presets.md).

Then review instance-specific copy:
- **Org noun** (team / association / coalition / custom) — drives position-section and relevance labels.

Use **Rerun AI on all bills** only if you want to regenerate already-processed summaries with different instructions.

---

## Observability

Each instance is a separate Worker in the Cloudflare dashboard. Health check:

```bash
curl https://[slug].[your-domain]/api/health
# { "ok": true }
```
