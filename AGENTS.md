# FloorVote

## What this is

Legislative bill tracking for teams. Each organization gets an isolated deployment (Cloudflare Worker + D1 + R2 + Queue). A shared central Worker ingests bills from LegiScan and fans them out to tenant Workers. Each tenant serves both the Hono API and the React SPA.

## Architecture

**Central/tenant split:** `central/` owns all legislative API calls and stores bill text in R2. Central does no AI processing. Tenants receive bills via per-tenant queues and run all AI (summary + tags + relevance) using each org's configured context and taxonomy. Tenants never call legislative APIs directly.

**Per-org isolation:** Every org is a separate wrangler environment with its own D1, Queue, and Worker. No shared multi-tenant database.

**Binding-authenticated RPC:** Tenant→central uses the `TenantApi` WorkerEntrypoint via service bindings. Central→tenant uses the `CentralApi` entrypoint. Neither direction transmits a shared secret.

**Bill pipeline:**
1. Central hourly cron → per-state keyword union filter → queue matching bills to ingestor
2. Ingestor → fetch bill + text from LegiScan → store in R2 → notify tenants
3. Tenant queue consumer → fetch from central → run AI → upsert to tenant D1

For the full sync pipeline (cron passes, ingestor fast/full path, deduplication, tenant message flags), see [`docs/internal/sync-pipeline.md`](docs/internal/sync-pipeline.md). The interactive companions are served from the docs site at [floorvote.org/docs/internal/sync-flow.html](https://floorvote.org/docs/internal/sync-flow.html) and [architecture.html](https://floorvote.org/docs/internal/architecture.html); their source lives in `docs/content/public/internal/`.

**Providers:** LegiScan is the recommended and actively maintained provider (`legiscan` wrangler env). An OpenStates provider also exists but is experimental and not at feature parity — see the note at the bottom of [`docs/content/self-hosting/index.md`](docs/content/self-hosting/index.md).

Maintainer-grade docs (sync pipeline, LegiScan API reference, email/calendar/Turnstile internals, style-token and date conventions) live in [docs/internal/](docs/internal/README.md) — flat, and not on the published docs site.

## Layout

```
api/        Tenant Worker (Hono + Drizzle + D1)
central/    Central Worker (standalone package, separate npm install)
web/        React 19 + Vite 8 + React Router 7 frontend
shared/     Shared modules (bill model, feed utils, markdown, tokens)
scripts/    Seeders and dev tooling
docs/content/  Published docs site (VitePress); docs/internal/ holds maintainer docs
graphify-out/  Generated knowledge graph (refreshed by CI; do not hand-edit)
```

This is the canonical project layout — the README intentionally does not duplicate it.

## Stack

| Layer | Technology |
|---|---|
| Backend | Hono 4.12 on Cloudflare Workers |
| Database | Cloudflare D1 (SQLite via Drizzle ORM) |
| Storage | Cloudflare R2 (bill text + masterlist cache) |
| Queues | Cloudflare Queues (ingestor + per-tenant delivery) |
| Frontend | React 19 + React Router 7 + Vite 8 (Workers Assets) |
| Email | Cloudflare Email Service (magic link auth); Resend available as a fallback via `EMAIL_PROVIDER` |
| AI | Google Gemini 2.5 Flash via Cloudflare AI Gateway. Model is hardcoded in `api/src/lib/llm.ts` — changing it is a code edit, not config |
| Legislative data | LegiScan |
| Testing | Vitest + @cloudflare/vitest-pool-workers; Vitest + jsdom |

---

## Deploying

Each tenant is a separate wrangler environment. Configuration lives in `api/wrangler.toml` (per-tenant) and `central/wrangler.toml`. See `*.example.toml` for documented templates.

```bash
# Deploy a tenant (from api/) — builds web, runs migrations, deploys
npm run deploy:tenant -- <env-name>

# Deploy central (from central/)
npm run deploy:legiscan     # LegiScan central (recommended)
npm run deploy              # OpenStates central (experimental)
```

`deploy.sh` builds the frontend, applies pending D1 migrations, and deploys the Worker. **Never run `wrangler deploy --env <tenant>` directly** — it skips migrations and the web build.

**Deploy ordering:** central first when adding endpoints tenants need; tenants first when removing endpoints; central first as safe default.

See [`docs/content/self-hosting/index.md`](docs/content/self-hosting/index.md) for full setup (D1, Queue, secrets, first admin user).

### Secrets and tokens

**Tenant workers** (`wrangler secret put <NAME> --env <tenant>` from `api/`):

| Secret | Purpose |
|---|---|
| `CF_AIG_TOKEN` | Cloudflare AI Gateway auth token (required) |
| `CENTRAL_ADMIN_SECRET` | Must match central's `ADMIN_SECRET`; removable after adding a CentralApi service binding |
| `TURNSTILE_SECRET_KEY` | Cloudflare Turnstile login protection (optional; unset → gate fails open) |
| `RESEND_API_KEY` | Optional fallback email provider (only when `EMAIL_PROVIDER=resend` or the Cloudflare `EMAIL` binding is absent) |
| `GEMINI_API_KEY` | Optional fallback AI key (only when `AI_GATEWAY_ENABLED` is unset/false) |

**Tenant vars** (in `[env.<tenant>.vars]` in `api/wrangler.toml`):

| Var | Purpose |
|---|---|
| `APP_URL` | Base URL for magic links and email links |
| `TENANT_ID` | Unique identifier for this org |
| `CENTRAL_API_URL` | URL of the central worker |
| `PROVIDER` | `legiscan` (recommended) or `openstates` |
| `STATE` | Two-letter state abbreviation (empty for multi-state) |
| `AI_GATEWAY_ENABLED` | `"true"` to route Gemini through Cloudflare AI Gateway |
| `CF_ACCOUNT_ID` | Cloudflare account ID (required for AI Gateway) |
| `CF_AIG_GATEWAY` | AI Gateway slug (required for AI Gateway) |
| `TURNSTILE_SITE_KEY` | Public Turnstile sitekey (optional; unset → no widget) |
| `SUPERADMIN_JWT_PUBLIC_KEY` | ES256 public JWK for verifying central-issued superadmin tokens (optional) |

**Central worker — LegiScan env** (`wrangler secret put <NAME> --env legiscan` from `central/`):

| Secret | Purpose |
|---|---|
| `LEGISCAN_API_KEY` | LegiScan bill data |
| `ADMIN_SECRET` | Protects `/api/admin/*` and `/api/tenants/*` routes |
| `RESEND_API_KEY` | Optional fallback for admin dashboard magic-link email (used unless `EMAIL_PROVIDER=cloudflare` and the `EMAIL` binding is set) |
| `CF_QUEUES_TOKEN` | Cloudflare API token (Queues: Edit) for dynamic per-tenant queue delivery |
| `SUPERADMIN_JWT_PRIVATE_KEY` | ES256 private JWK — central is the sole issuer of superadmin tokens |
| `SUPERADMIN_EMAILS` | Comma-separated superadmin allowlist |
| `CF_ANALYTICS_TOKEN` | Cloudflare API token for two features: D1 anomaly watch (Account → D1: Read) and Login Activity delivery status (Zone → Analytics: Read, scoped to `CF_FLOORVOTE_ZONE_ID`'s zone). Both permission groups can live on one token. (optional) |
| `CF_FLOORVOTE_ZONE_ID` | Cloudflare zone ID (not account ID — found on the domain's Overview page) for the Login Activity delivery-status GraphQL query. Required alongside `CF_ANALYTICS_TOKEN`'s zone permission for that feature; otherwise it silently no-ops. (optional) |
| `CF_EMAIL_TOKEN` | Cloudflare API token (Email Sending: Read) for login-activity suppression banner (optional) |
| `TURNSTILE_SECRET_KEY` | Cloudflare Turnstile for dashboard login (optional) |

**Central vars** (in `[env.legiscan.vars]` in `central/wrangler.toml`):

| Var | Purpose |
|---|---|
| `BILL_PROVIDER` | `legiscan` |
| `OPERATOR_NAME` | Display name for the operator |
| `ADMIN_APP_URL` | Base URL for the admin dashboard (for magic-link emails) |
| `CF_ACCOUNT_ID` | Cloudflare account ID (for analytics queries) |
| `SUPERADMIN_JWT_PUBLIC_KEY` | ES256 public JWK (same value as on tenants) |
| `TURNSTILE_SITE_KEY` | Public Turnstile sitekey for dashboard login (optional) |

For local dev: `cp api/.dev.vars.example api/.dev.vars` (and `central/.dev.vars.example` if working on central). Both are fully annotated and every key is optional for `npm run dev:local` — the file just needs to exist. Uncomment a key only to exercise that integration locally.

### Database

Tenant migrations: `api/migrations/`. Central migrations: `central/migrations/`. Schema source of truth: `api/src/db/schema.ts` (tenant), `central/src/db/schema.ts` / `schema-legiscan.ts` (central).

**Always add new migration files — never edit existing ones.**

```bash
# Tenant
cd api && npm run migrate:local    # local D1
cd api && npm run migrate:remote   # production D1

# Central
cd central && npm run migrate:local
cd central && npm run migrate:remote
```

### LegiScan API quota

30,000 calls/month on the free tier. Never bulk-queue bills to the ingestor without `skipFetch: true`. Safe bulk operations: `reprocess` (zero API calls), `redownload-texts` (`skipFetch: true`, downloads from legislature site).

---

## Developing

See the [Contributing page](https://floorvote.org/docs/contributing/) on the docs site for local dev setup and PR expectations.

```bash
npm run dev:local    # seeded DB, auto-login, ports 8787 + 5173
cd api && npm test   # real D1 bindings, not mocks
cd central && npm test
cd web && npm test
```

`central/` is a standalone package — run `npm install` separately.

### Styling

Inline `style={{}}` backed by design tokens from `web/src/styles/tokens.ts` (`color`, `radius`, `fontSize`, `fontWeight`, `shadow`). ESLint blocks raw hex colors and raw `borderRadius`/`fontSize`/`fontWeight` values. Spacing (padding, margin, gap) is intentionally NOT tokenized — use raw numbers.

Material Symbols icons use an explicit allowlist in `web/index.html` — add new icons to the `icon_names=` query param before using them. Unregistered icons silently render as their literal name text.

### Navigation

In-app page transitions hold the current page with a wait cursor while the destination loads, then swap. Never show a full-page spinner during navigation.

Route loaders must use `apiFetchForLoader` (not raw `apiFetch`) — a raw 401 bypasses auth and crashes the app.

### Rules

1. Import colors/radii/font sizes from `web/src/styles/tokens.ts`. Spacing is raw numbers.
2. Register Material Symbols icons in `icon_names=` in `web/index.html` before use.
3. Never edit existing migration files — create new ones.
4. Timestamps: `datetime('now')` in SQL, never ISO. Frontend: `feedTsToEpoch`.
5. Relevance scores are 1–10, not 0–100.
6. Tenants never call legislative APIs directly — all data flows through central.
7. Use `apiFetchForLoader` in route loaders, not raw `apiFetch`.
8. Light theme only. No full-page spinners on navigation.
9. Never run `wrangler deploy` directly — use `npm run deploy:tenant`.
10. Don't mock D1 in tests — use real @cloudflare/vitest-pool-workers bindings.
11. Don't leave `web/dist` around during local dev — it breaks the Vite `/api` proxy.

### Conventions

- **Working in a fork.** If your checkout carries operator-specific files not tracked upstream (e.g. deploy configs, an internal ops runbook), decide up front whether a change belongs upstream or stays fork-only before creating a worktree or branch — see [Forking and operator overlays](https://floorvote.org/docs/contributing/#forking-and-operator-overlays).

## graphify

If `graphify-out/graph.json` exists, run `graphify query "<question>"` before grepping source files.
