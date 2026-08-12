# Adding a tenant

A tenant is one team's instance: a single Cloudflare Worker + D1 database + queue. The Worker serves both the API and the app, and all bill data flows from your [central service](/self-hosting/) — tenants never call LegiScan directly. This page assumes your central service is already running.

Throughout, replace `[slug]` with a lowercase identifier for the team (e.g. `org-nj`) and `[STATE]` with its two-letter abbreviation.

> [!TIP]
> **Shortcut:** `scripts/new-instance.sh` automates every step below — it creates the database and queue, appends the config block, deploys, sets the secret, binds the tenant on central, registers it, optionally seeds history, and creates the first user. Use `--from-step N` to resume after a failure. The manual steps below are the reference, and worth reading once before your first run.

> [!NOTE]
> **Renamed resources?** The commands below name every Cloudflare resource `floorvote-…` — the worker, the D1 database, the queues, and the shared `floorvote-dlq`. If your deployment uses a different resource prefix (anything other than the default `floorvote`), substitute it consistently everywhere you see `floorvote-` below — **and** make sure it matches the `TENANT_QUEUE_PREFIX` set on your central service. Otherwise central looks for a queue that doesn't exist, silently creates a phantom with no consumer, and the tenant receives no bills.

## Cloudflare credentials

Adding a tenant reuses the account-level credentials you set up once and then reuse for every team:

- **Deploy token (`CLOUDFLARE_API_TOKEN`)** — the one you already created and exported when setting up the [central service](/self-hosting/#cloudflare-api-tokens). Same token here.
- **AI Gateway** — AI runs on the tenant side, routed through a Cloudflare AI Gateway for keyless, unified billing. Create one gateway once and every tenant shares it: in the dashboard, **AI → AI Gateway → Create Gateway**, name it (e.g. `floorvote`), and put the slug in each tenant's `CF_AIG_GATEWAY` var.
- **AI Gateway token (`CF_AIG_TOKEN`)** — in your gateway's **Settings**, **Create authentication token** (it gets the "Run" permission — copy it now, it's shown once) and toggle **Authenticated Gateway** on. This is the one secret you set on every tenant, with the same value each time.

> [!NOTE]
> The AI Gateway token is account-scoped — any "AI Gateway Run" token can send requests through every gateway on the account. That's fine here because all tenants intentionally share one gateway.

For which pieces can be scripted versus created by hand in the dashboard, see [`docs/internal/tenant-automation.md`](https://github.com/floorvote/floorvote/blob/main/docs/internal/tenant-automation.md) in the repository.

## Prerequisites

- Your central service is deployed and running.
- `wrangler` installed and your `CLOUDFLARE_API_TOKEN` exported (see the [central setup](/self-hosting/#cloudflare-api-tokens)).
- The repository cloned, with dependencies installed.
- Your AI Gateway created, and its token and slug handy.

## Step 1: Create a database

```bash
npx wrangler d1 create floorvote-[slug]
```

Save the `database_id` from the output.

## Step 2: Create a queue

```bash
npx wrangler queues create floorvote-[slug]-queue
```

Every tenant's queue consumer names a shared dead-letter queue. It isn't created for you, and a tenant deploy fails outright if it doesn't exist — so create it once, before your first tenant:

```bash
npx wrangler queues create floorvote-dlq
```

Later tenants reuse the same one; running this again for a second tenant is harmless but unnecessary.

## Step 3: Add a config block to `api/wrangler.toml`

Copy the `CF_ACCOUNT_ID`, `CF_AIG_GATEWAY`, `CENTRAL_API_URL`, and `SUPERADMIN_JWT_PUBLIC_KEY` values from an existing tenant block — they're identical across every tenant. See `api/wrangler.example.toml` for a documented template.

> [!NOTE]
> **Your first tenant?** There's no existing block to copy those four from yet — here's where each comes from:
> - `CENTRAL_API_URL` — your central worker's URL, which wrangler printed (and told you to note) when you deployed central. See the [central setup](/self-hosting/). No dashboard needed.
> - `CF_ACCOUNT_ID` — your Cloudflare account ID.
> - `CF_AIG_GATEWAY` — the AI Gateway slug you created under [Cloudflare credentials](#cloudflare-credentials) above.
> - `SUPERADMIN_JWT_PUBLIC_KEY` — the public key from the superadmin key-generation step in the central setup.

> [!IMPORTANT]
> The shared, top-level `[assets]` block (inherited by every tenant env) must include `run_worker_first = ["/api/*"]`:
>
> ```toml
> [assets]
> directory = "../web/dist"
> binding = "ASSETS"
> not_found_handling = "single-page-application"
> run_worker_first = ["/api/*"]
> ```
>
> Without it, a compatibility date of 2025-04-01 or later makes browser navigations to any `/api/*` URL serve the SPA shell instead of hitting the Worker — so opening a bill text with "Open in new tab" lands on the app feed. Client-side `fetch()` still reaches the Worker, so the in-page bill-text viewer works either way, which makes the difference easy to miss. This is set once in the top-level block, not per tenant.

```toml
[env.[slug]]
name = "floorvote-[slug]"
routes = [{ pattern = "[slug].[your-domain]", custom_domain = true }]

# wrangler doesn't inherit the top-level [define] into named environments, so
# each env needs its own or wrangler warns on every command. BUILD_SHA is
# overridden at deploy; "'dev'" is just the placeholder.
[env.[slug].define]
BUILD_SHA = "'dev'"

[env.[slug].vars]
APP_URL = "https://[slug].[your-domain]"
ASSOCIATION_NAME = "[Full Organization Name]"

# optional — footer credit
OPERATOR_NAME = "Your Operator Name"

# optional — footer link
OPERATOR_URL = "https://example.org"

# optional — feedback recipient(s)
OPERATOR_CONTACT_EMAILS = "support@example.org"

# applied automatically on first register
INSTANCE_PRESET = "election_officials"

# e.g. "NJ"; leave "" for a multi-state team
STATE = "[STATE]"

TENANT_ID = "[slug]"
PROVIDER = "legiscan"
CENTRAL_API_URL = "https://<your-central>.workers.dev"
AI_GATEWAY_ENABLED = "true"
CF_ACCOUNT_ID = "<your-account-id>"
CF_AIG_GATEWAY = "<your-gateway-slug>"
EMAIL_PROVIDER = "cloudflare"

# who gets cron-failure alerts
ALERT_EMAILS = "ops@example.org"

# the domain this team is served on
APP_DOMAINS = "[your-domain]"

# sender address (domain must be verified to send)
EMAIL_FROM = "notifications@[your-domain]"

# optional — bulk mail (digest, week-ahead) sender; segments sending reputation
# onto a dedicated subdomain. Falls back to EMAIL_FROM when unset. Domain must be verified.
EMAIL_FROM_BULK = "notifications@mail.[your-domain]"

# copy verbatim from any existing tenant block
SUPERADMIN_JWT_PUBLIC_KEY = '<your-ES256-public-JWK>'

# optional; see the Turnstile page
TURNSTILE_SITE_KEY = "<your-turnstile-site-key>"

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
# namespace_id (any integer, just not shared with another tenant).
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
# daily — sends digest and week-ahead emails
crons = ["0 11 * * *"]
```

The `entrypoint = "TenantApi"` on the `CENTRAL` binding is what lets outbound tenant-to-central calls authenticate by *arrival* (that named entrypoint is only reachable over same-account bindings), so the tenant carries no shared secret.

> [!NOTE]
> **Multi-state team:** set `STATE = ""` and store the state list in the database instead (Step 4b). `APP_DOMAINS` is normally one domain; list two only while migrating domains, then drop back to one.

> [!NOTE]
> **Queue delivery needs no central change.** As long as `CF_QUEUES_TOKEN` is set on central, central finds this tenant's queue at registration and delivers to it. (A static `TENANT_QUEUE_` producer binding on central is only worth adding for a very high-volume tenant; most never need it.)

Commit `api/wrangler.toml` before deploying.

## Step 4: Run migrations

From `api/`:

```bash
npx wrangler d1 migrations apply floorvote-[slug] --remote --env [slug]
```

> [!WARNING]
> Always use `migrations apply`, never `d1 execute` with raw SQL files — `apply` tracks which migrations have run.

## Step 4b: Seed the state list (multi-state teams only)

Single-state teams skip this — the `STATE` var is enough. For a multi-state team, from `api/`, store the list in the database:

```bash
npx wrangler d1 execute floorvote-[slug] --remote --env [slug] \
  --command "INSERT OR REPLACE INTO association_config (key, value) VALUES ('state_coverage', '[\"NJ\",\"RI\",\"WY\",\"WI\"]')"
```

## Step 5: Deploy the worker

From `api/`:

```bash
npm run deploy:tenant -- [slug]
```

This builds the frontend, applies pending migrations, and deploys the worker. Never run `wrangler deploy --env [slug]` directly — that skips the build and migrations.

## Step 6: Set the tenant secret

Set this **after** the first deploy — `wrangler secret put` errors if the worker doesn't exist yet. From `api/`, **only `CF_AIG_TOKEN` is required** — paste the same value you used for your last tenant:

```bash
npx wrangler secret put CF_AIG_TOKEN --env [slug]
```

> [!TIP]
> **Optional fallbacks**, not used on the normal path: `GEMINI_API_KEY` (only read if you flip `AI_GATEWAY_ENABLED` to `"false"`) and `RESEND_API_KEY` (only if you set `EMAIL_PROVIDER="resend"` instead of Cloudflare Email Service). You don't set `LEGISCAN_API_KEY` on a tenant — only central calls LegiScan.

## Step 7: Bind the tenant on central

Central-to-tenant calls (engagement stats, force-register, digests) run over a per-tenant binding. Because the tenant worker must exist first, do this **after** the first deploy. Add the binding to `central/wrangler.toml` (the name is `TENANT_` + the slug uppercased, hyphens becoming underscores):

```toml
[[env.legiscan.services]]
binding = "TENANT_[SLUG_UPPERCASED]"
service = "floorvote-[slug]"
entrypoint = "CentralApi"
```

Then redeploy central so the binding resolves:

```bash
cd central && npm run deploy:legiscan
```

## Step 8: Register the tenant with central

This applies the `INSTANCE_PRESET` (keywords, AI context, taxonomy, relevance question), syncs the keywords to central, and registers the team's state coverage:

> [!TIP]
> **You already have both of these — no dashboard needed.** `https://<your-central>.workers.dev` is your `CENTRAL_API_URL` from the Step 3 config block (and the URL wrangler printed when you deployed central). `<central ADMIN_SECRET>` is the `ADMIN_SECRET` you set on central during its setup — the same value for every tenant. To make the commands here and in Step 12 copy-pasteable, export them once:
> ```bash
> export CENTRAL="https://<your-central>.workers.dev"   # your CENTRAL_API_URL
> export ADMIN_SECRET="<central ADMIN_SECRET>"
> ```

```bash
curl -X POST "$CENTRAL/api/tenants/[slug]/force-register" \
  -H "x-admin-secret: $ADMIN_SECRET"
```

(The tenant also self-registers on its daily cron and whenever you save config in the app — `force-register` just does it right now.) Verify:

```bash
# Expected response: { "ok": true }
curl https://[slug].[your-domain]/api/health
```

## Step 9: Set up the custom domain

The custom domain comes from the `routes` field in your config block (Step 3) — when you deploy, Cloudflare provisions the domain and its TLS certificate automatically. If your domain's DNS is managed in Cloudflare, there's nothing more to do. For an external domain, add a CNAME pointing the subdomain at `floorvote-[slug].<your-account>.workers.dev` and update `APP_URL` to match.

## Step 10: Create the founding owner

There's no self-signup. From `api/`, insert the first user directly, and make them an `owner`, **not** an `admin` — only an owner can grant the owner role, so a team whose first user is a plain admin can never have one:

```bash
npx wrangler d1 execute floorvote-[slug] --remote --env [slug] \
  --command "INSERT INTO users (id, email, name, role) VALUES ('$(uuidgen)', '<owner-email>', '<owner-name>', 'owner')"
```

Replace `<owner-email>` and `<owner-name>` with the founding owner's real email and display name; keep `role` as `owner`. Leave `$(uuidgen)` exactly as written — it's **not** a placeholder, it's a shell command your terminal runs to generate the user's unique `id` (standard on macOS and most Linux; if yours lacks it, paste any UUID instead).

They then log in with a magic link sent to that email address.

## Step 11: Confirm the preset and configuration

Now switch from the terminal to a browser. Go to your instance at the `APP_URL` from your Step 3 config block — `https://[slug].[your-domain]` (the custom domain from Step 9). There's no password: enter the founding owner's email from Step 10 and the app emails you a magic link; click it to sign in, then open **Settings → Configuration**. If you set `INSTANCE_PRESET` in Step 3 (recommended), the keywords, AI context, taxonomy, and relevance question are already in place — applied once at registration, so anything you change here sticks. If not, apply a preset now — see [Presets](/self-hosting/presets). **This is the moment to adjust them** — you're setting the config the seed in Step 12 will spend AI against, so tune the keywords and AI instructions here first.

You can also set these four fields directly in the database if you prefer (from `api/`). They live in the `association_config` table:

| Key | Example |
|-----|---------|
| `keywords` | `["election","voter","ballot","polling","absentee","referendum"]` |
| `ai_context` | `"You are analyzing bills for an association of local election officials who administer elections at the county and municipal level."` |
| `relevance_question` | `"Is this bill relevant to local election administration? Consider operational impact, funding, staffing, and legal authority."` |
| `state_coverage` | `["NJ"]` — or `["*"]` for all states, `["*","US"]` for all states plus Congress |
| `tag_taxonomy` | `["Voter Registration","Ballot Access","Election Funding","Poll Workers","Redistricting","Election Security"]` |

```bash
wrangler d1 execute floorvote-[slug] --remote --env [slug] \
  --command "INSERT INTO association_config (key, value) VALUES
    ('keywords', '[\"election\",\"voter\",\"ballot\"]'),
    ('ai_context', 'You are analyzing bills for an association of local election officials.'),
    ('relevance_question', 'Is this bill relevant to local election administration?'),
    ('state_coverage', '[\"NJ\"]')"
```

While you're here, set the **org noun** (team / association / coalition / custom) — it drives the labels on the positions section. (**Rerun AI on all bills** is for later — after bills are in — if you re-tune your instructions and want to regenerate existing summaries.)

> [!NOTE]
> **Tuning at your own pace?** If another team already tracks this state, central has its bills and can start delivering them before you seed — summarized with whatever keywords are set (the un-tuned preset, if you haven't changed them yet). To avoid any AI spend while you work, clear the keywords: with none set, every bill arrives as a no-cost stub. Restore your real keywords when you're ready, then seed in Step 12.

## Step 12: Seed the active session(s)

Seeding loads a whole legislative session into the team at once — bills matching its keywords get full AI summaries, and the rest come in as lightweight "monitor" stubs (no AI cost). This means the team mirrors the full session from day one.

> [!TIP]
> **Keywords come from Step 11.** Seeding uses the keywords already synced to central to decide which bills get full AI versus a stub. If you still need to change them, do it in **Settings → Configuration** and let it sync **first**; changing them after seeding works too, but then you'd "Rerun AI on all bills" to regenerate.

There are two paths, depending on whether central already has the state's bills.

### Path A: central already has the session

If another team already tracks the state, central has its bills. First, find the session's numeric id in central's `sessions` table — from `central/` (the database name is the `database_name` in `central/wrangler.toml`):

```bash
npx wrangler d1 execute <central-db> --remote --env legiscan \
  --command "SELECT session_id, session_name, year_start, sine_die FROM sessions WHERE state = '[STATE]' ORDER BY year_start DESC"
```

Then seed in pages — the command handles up to 500 bills per call and tells you whether it finished:

```bash
curl -s -X POST \
  "$CENTRAL/api/tenants/seed-session/[slug]?sessionId=[sessionId]&offset=0" \
  -H "x-admin-secret: $ADMIN_SECRET"
```

If the response shows `"done": true`, you're finished. If not, run it again with `offset` set to the `nextOffset` it returned. This loop does that for you until it's done:

```bash
OFFSET=0
while true; do
  RESP=$(curl -s -X POST "$CENTRAL/api/tenants/seed-session/[slug]?sessionId=[sessionId]&offset=$OFFSET&limit=500" \
    -H "x-admin-secret: $ADMIN_SECRET")
  echo "$RESP"
  DONE=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('done',''))")
  NEXT=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('nextOffset') or '')")
  if [ "$DONE" = "True" ] || [ -z "$NEXT" ]; then break; fi
  OFFSET=$NEXT
done
```

This makes no LegiScan API calls, and takes a few minutes for a large state (~10,000 bills) — it only *links* bills central already holds. Don't carry that figure over to Path B, which has to load those bills into central first and is far slower; see the timing warning there.

> [!NOTE]
> **If the queue rate-limits you.** Linking a large session sends tens of thousands of queue messages, which can hit Cloudflare Queues limits. The endpoint then returns HTTP 429 and reports the `offset` it stopped at, so nothing is lost. Add `&skipQueue=true` to create the `bill_tenants` links without sending anything to a queue, page through the rest of the session that way, then queue the work in one pass once you have headroom:
>
> ```bash
> curl -X POST "$CENTRAL/api/tenants/reprocess/[slug]" \
>   -H "x-admin-secret: $ADMIN_SECRET"
> ```
>
> `reprocess` sends straight to the team's queue and costs no LegiScan API calls.

> [!NOTE]
> **"Active" includes a session that has already adjourned.** Seed the most recent regular (and any special) session — a legislature that has gone `sine_die` for the cycle is still exactly what a new team wants to monitor. (That's the `sine_die = 1` row in the query above.)

### Path B: brand-new state (central has no bills yet)

Load central from the LegiScan bulk zip first (as in [Preload historical bills](/self-hosting/#optional-preload-historical-bills-now)), but include the `--tenant` flag so it links the bills to this team in one shot:

```bash
CENTRAL_API_URL="$CENTRAL" CENTRAL_ADMIN_SECRET="$ADMIN_SECRET" \
npx tsx scripts/seed-legiscan.ts \
  --from-dir path/to/RI/2026-2026_Regular_Session \
  --state RI \
  --session-id 2253 \
  --tenant [slug] \
  --remote
```

The `--session-id` is LegiScan's numeric session id. You download the zip from the [datasets page](https://legiscan.com/gaits/datasets), but the site doesn't show the id — the reliable way to find it is to open any bill JSON in the extracted dataset (e.g. `bill/HB0001.json`; the names are zero-padded and the exact width varies by state) and read the `session_id` field near the top. (Or run the seeder with `--from-api` instead of `--from-dir`, which fetches the session list and prints each `session_name (id=…)` to pick from.)

An extracted session is hundreds of MB of JSON, so keep it out of version control — `bulkseed/` and `bulkseeds/` are both gitignored if you want it alongside the repo.

The `--tenant` flag links the bills and updates the team's `state_coverage` — no separate `seed-session` call needed.

> [!WARNING]
> **Budget hours, not minutes.** The seeder writes to central's D1 in batches over HTTP, so throughput is bounded by round-trip latency, not by your machine — about **45 bills/min** (measured 43–50/min across two states). Roll calls add time at a similar rate.
>
> | Session size | Expect roughly |
> |---|---|
> | ~1,000 bills | 20 min |
> | ~4,000 bills | 1.5 hr |
> | ~12,000 bills | 4 hr |
>
> Start a big state somewhere it can run unattended — a terminal you can leave open, `tmux`, or a background run with output going to a log. Seeding is idempotent, so if a run dies partway, re-run the same command and it picks up rather than duplicating.

> [!TIP]
> **Watching a long seed.** The seeder prints a running count. On a terminal that's an in-place counter; when stdout isn't a terminal (backgrounded, or piped to `tee`) it switches to one line per batch so a log file shows real progress. To check from another shell, count the rows in central directly:
>
> ```bash
> npx wrangler d1 execute <central-db> --remote --env legiscan \
>   --command "SELECT COUNT(*) FROM bills WHERE session_id = [sessionId]"
> ```

> [!NOTE]
> **Seeding several states at once?** Run one invocation per session, **sequentially**. Parallel runs compete for the same D1 write path and the same queue budget, and the win would be small anyway since latency — not local CPU — is the limit. A team whose coverage is the `["*"]` wildcard keeps it: the link step merges coverage additively and short-circuits on the wildcard, so seeding IL never narrows a wildcard team to `["IL"]`.

> [!WARNING]
> **`--tenant --remote` needs `CENTRAL_API_URL`.** The seeder writes bills straight to central's database, but the `--tenant` link step calls central's API over HTTP. Without `CENTRAL_API_URL` (and the admin secret) it silently falls back to `http://localhost:8787` and dies with `fetch failed` *after* seeding — the `$CENTRAL` and `$ADMIN_SECRET` you exported in Step 8 cover both.

> [!WARNING]
> Per-legislator vote records are slow to seed on large states (20–30 min) and are skipped by default. Add `--with-individual-votes` to include them, or `--skip-votes` to skip roll calls entirely. **Quota note:** never bulk-queue bills without `--skip-fetch`/`skipFetch` — the seeder handles this for you; the free LegiScan tier is 30,000 calls/month.

## Step 13: Link bills and queue AI (only if you skipped `--tenant`)

Only needed if you ran Path B **without** `--tenant`. This links the seeded bills to the team and queues the keyword matches for text download and AI:

```bash
curl -X POST "$CENTRAL/api/tenants/seed-session/[slug]?sessionId=[sessionId]" \
  -H "x-admin-secret: $ADMIN_SECRET"
```

For more than 500 bills, page through it the same way as Path A (advance `&offset=` until `"done": true`).

## When do bills start flowing in?

Registration stores the team's keywords and state coverage and provisions its queue, but doesn't itself queue any bills. Delivery is driven by the hourly **central cron**, and timing depends on whether central already tracks the state:

- **State already tracked by another team:** the next full-sync pass links this team's bills and queues the keyword matches. Full passes run three times a day, so within ~10 hours — no seeding required.
- **Brand-new state, not seeded:** central discovers the session on its once-a-day pass, then bills flow — worst case ~24 hours.
- **Want bills immediately:** run the seed in Step 12.

Non-keyword bills arrive as lightweight monitor stubs; keyword and manually-added bills get full AI summaries.
