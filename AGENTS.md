# FloorVote

## What this is

Legislative bill tracking for teams. Each organization gets an isolated deployment (Cloudflare Worker + D1 + R2 + Queue). A shared central Worker ingests bills from a data provider (LegiScan by default, or a legislature's own feed for the states that have one) and fans them out to tenant Workers. Each tenant serves both the Hono API and the React SPA.

## Architecture

**Central/tenant split:** `central/` owns all legislative API calls and stores bill text in R2. Central does no AI processing. Tenants receive bills via per-tenant queues and run all AI (summary + tags + relevance) using each org's configured context and taxonomy. Tenants never call legislative APIs directly.

**Per-org isolation:** Every org is a separate wrangler environment with its own D1, Queue, and Worker. No shared multi-tenant database.

**Binding-authenticated RPC:** Tenant→central uses the `TenantApi` WorkerEntrypoint via service bindings. Central→tenant uses the `CentralApi` entrypoint. Neither direction transmits a shared secret. A consumer Worker on the same account that reads engagement stats (every tenant's daily `tenant_stats` rows) binds to central's separate `StatsApi` entrypoint and calls `tenantStatsSince("YYYY-MM-DD")`; it has no HTTP route, and tenants never bind to it.

**Providers:** central reads legislative data through providers in `central/src/providers/`, with LegiScan the default. A provider calls its API and maps responses into the shapes in `providers/types.ts`, and core writes the results. ESLint lets provider code import only `providers/sdk.ts` and core import providers only through the registry, `providers/index.ts` (`central/eslint-provider-boundary.mjs`). A provider's `ctx.env` holds only the env keys it declares in `envKeys`, and its `vocabulary.ts` gives every status it writes a label, common stage, rank, terminal flag, and explainer. Its relationship labels map there to `identical`, `package`, or `related` kinds, by name and with per-state overrides, and central attaches the kind when it serves a bill's related bills. Fields only one provider publishes are declared there as extras and shown in one generic panel on the bill page, never sorted, filtered, notified on, or sent to AI, and every provider keeps a field inventory its mapping test checks fixtures against (see "Provider extras" in `docs/internal/sync-pipeline.md`). A provider that publishes the legislature's own calendar implements `listBodyEvents` (body events: hearings, roundtables, and meetings, with or without bills, shown on instances' calendars as each instance's event rules choose, as "Body events" in `docs/internal/sync-pipeline.md` describes), and instances gate features on each state's capabilities, never its name. Central's `state_providers` table records which provider each state syncs from, and a state with no row is LegiScan's. A cutover (`central/src/lib/cutover.ts`) moves a state instances already track to another provider, keeping every bill's handle and never writing to an instance's database. DC (LIMS), Maryland (MGA), Virginia (LIS), and Congress (GovInfo Bill Status) are opt-in providers, off until an admin claim gives them a state, and synced as snapshots by `cron/sync-snapshots.ts` (see `docs/internal/sync-pipeline.md`, whose "DC Council (LIMS)" section covers DC's mapping, its fail-closed rules, and the re-ingest a LIMS mapping change needs, and whose "Maryland (MGA)", "Virginia (LIS)", and "Congress (GovInfo Bill Status)" sections cover those states).

**Bill pipeline:**
1. Central hourly cron → per-state keyword union filter → queue matching bills to ingestor
2. Ingestor → fetch bill + text from the state's provider (LegiScan by default) → store in R2 → notify tenants
3. Tenant queue consumer → fetch from central → run AI → upsert to tenant D1

For the full sync pipeline (cron passes, ingestor fast/full path, deduplication, tenant message flags), see [`docs/internal/sync-pipeline.md`](docs/internal/sync-pipeline.md). The interactive companions are served from the docs site at [floorvote.org/docs/internal/sync-flow.html](https://floorvote.org/docs/internal/sync-flow.html) and [architecture.html](https://floorvote.org/docs/internal/architecture.html); their source lives in `docs/content/public/internal/`.

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
| Backend | Hono 4.13 on Cloudflare Workers |
| Database | Cloudflare D1 (SQLite via Drizzle ORM) |
| Storage | Cloudflare R2 (bill text) |
| Queues | Cloudflare Queues (ingestor + per-tenant delivery) |
| Frontend | React 19 + React Router 7 + Vite 8 (Workers Assets) |
| Email | Cloudflare Email Service (magic link auth); Resend available as a fallback via `EMAIL_PROVIDER` |
| AI | Google Gemini 2.5 Flash via Cloudflare AI Gateway. `api/src/lib/llm.ts` holds the default; override per env with the `GEMINI_MODEL` and `GEMINI_THINKING_BUDGET` vars |
| Legislative data | LegiScan by default, plus opt-in providers for DC (LIMS), Maryland (MGA), Virginia (LIS), and Congress (GovInfo) |
| Testing | Vitest + @cloudflare/vitest-pool-workers; Vitest + jsdom |

---

## Deploying

Each tenant is a separate wrangler environment. Configuration lives in `api/wrangler.toml` (per-tenant) and `central/wrangler.toml`. See `*.example.toml` for documented templates.

```bash
# Deploy a tenant (from api/) — builds web, runs migrations, deploys
npm run deploy:tenant -- <env-name>

# Deploy central (from central/)
npm run deploy:legiscan     # `npm run deploy` is an alias
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
| `RESEND_API_KEY` | Admin dashboard magic-link email, unless central sends through Cloudflare Email (`EMAIL_PROVIDER=cloudflare` with an `EMAIL` binding). Dashboard login needs one of those two senders plus `ADMIN_APP_URL`: `dash-auth.ts` sends nothing, logs a warning, and still answers ok if either is missing |
| `CF_QUEUES_TOKEN` | Cloudflare API token (Queues: Edit) for dynamic per-tenant queue delivery |
| `SUPERADMIN_JWT_PRIVATE_KEY` | ES256 private JWK — central is the sole issuer of superadmin tokens |
| `SUPERADMIN_EMAILS` | Comma-separated superadmin allowlist |
| `CF_ANALYTICS_TOKEN` | Cloudflare API token for two features: D1 anomaly watch (Account → D1: Read) and Login Activity delivery status (Zone → Analytics: Read, scoped to `CF_FLOORVOTE_ZONE_ID`'s zone). Both permission groups can live on one token. (optional) |
| `CF_FLOORVOTE_ZONE_ID` | Cloudflare zone ID (not account ID — found on the domain's Overview page) for the Login Activity delivery-status GraphQL query. Required alongside `CF_ANALYTICS_TOKEN`'s zone permission for that feature; otherwise it silently no-ops. (optional) |
| `CF_EMAIL_TOKEN` | Cloudflare API token (Email Sending: Read) for reading the suppression list: the login-activity suppression banner, and the previously-bounced check in bulk invite and change-email. Without it, that check counts only bounces the instance recorded. (optional) |
| `TURNSTILE_SECRET_KEY` | Cloudflare Turnstile for dashboard login (optional) |

**Central vars** (in `[env.legiscan.vars]` in `central/wrangler.toml`):

| Var | Purpose |
|---|---|
| `OPERATOR_NAME` | Display name for the operator |
| `ADMIN_APP_URL` | Base URL for the admin dashboard (for magic-link emails). Also sent to instances, with the body-events answer, for the superadmin Profile link |
| `CF_ACCOUNT_ID` | Cloudflare account ID (for analytics queries) |
| `SUPERADMIN_JWT_PUBLIC_KEY` | ES256 public JWK (same value as on tenants) |
| `TURNSTILE_SITE_KEY` | Public Turnstile sitekey for dashboard login (optional) |

For local dev: `cp api/.dev.vars.example api/.dev.vars` (and `central/.dev.vars.example` if working on central). Both are fully annotated and every key is optional for `npm run dev:local` — the file just needs to exist. Uncomment a key only to exercise that integration locally.

### Database

Tenant migrations: `api/migrations/`. Central migrations: `central/migrations-legiscan/`. Schema source of truth: `api/src/db/schema.ts` (tenant), `central/src/db/schema.ts` (central).

**Always add new migration files — never edit existing ones.**

**Keep `;` out of SQL comments in `api/migrations/`.** The api test helper (`parseMigration` in `api/test/helpers.ts`) splits a file on `;` before it strips comments, so the words after the semicolon run as SQL. Every test that calls `applyMigrations()` then fails with a syntax error that points at the prose, not the cause. A period or an em dash does the same job.

**A migration with a trigger** (0103 is the first) registers in `applyMigrations` through `splitStatements`, not `parseMigration`, which would split the trigger's body apart. Wrangler ends a `CREATE TRIGGER` at the first `END` that follows a `;` and is followed by `;` (whitespace between, any case), and `splitStatements` follows the same rule. A migration that rebuilds `bills` must recreate 0106's `bills_group_tags_*` triggers (which replaced 0103's) and `idx_bills_group_tags`, and nothing may write `bills` with `INSERT OR REPLACE`, which skips the delete trigger and leaves a stale group tag that matches.

**Numbers and names a downstream fork owns.** Open-City-Advocates' fork applied its own migrations in production, and moving it onto upstream depends on these staying free (`docs/internal/fork-upgrade.md`):

- Central 0022, 0023, and 0024 and tenant 0071, 0072, and 0074 are reserved forever. Skip them.
- Numbers 0900 and up, in both folders, are left for fork-only migrations (`0900_oca_*`). Upstream never uses them.
- Upstream never creates, alters, or drops the fork's tables and columns, and never assumes they exist or don't. Central: `council_events`, `council_committees`, `council_directory`, `council_committee_history`, `council_changes`, and `people.term_start`, `people.term_end`, and `people.seated`. Tenant: `deep_analyses`, `team_links`, `crm_people`, `crm_contacts`, and `crm_followups`. Pick other names, and never `INSERT … SELECT` from a table that may not exist.

```bash
# Tenant
cd api && npm run migrate:local    # local D1
cd api && npm run migrate:remote   # production D1

# Central
cd central && npm run migrate:local
cd central && npm run migrate:remote
```

### LegiScan API quota

10,000 calls/month on the free tier. Never bulk-queue bills to the ingestor without `skipFetch: true`. Safe bulk operations: `reprocess` (zero API calls), `redownload-texts` (`skipFetch: true`, downloads from legislature site).

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

Enable the repo's git hooks once per clone:

```bash
git config core.hooksPath .githooks
```

`commit-msg` warns when a commit has no `Signed-off-by` trailer, which the DCO check requires. Without the warning you find out on an already-open PR, where the fix is an amend plus a force-push.

It warns rather than adding the trailer, and that is deliberate. The sign-off is your own certification under the [DCO](DCO) that you have the right to submit the work under the project's license — a hook that supplies it for you turns a real attestation into something tooling stamps automatically. Sign with `git commit -s`, or `git commit --amend -s` after the fact.

### Fast checks

While iterating, run the narrow check for the package you're in. CI runs the full lint and test jobs (`.github/workflows/ci.yml`).

```bash
# Typecheck, one per package (the same commands CI runs)
cd api && npx tsc --noEmit -p tsconfig.build.json
cd central && npx tsc --noEmit -p tsconfig.build.json
cd web && npx tsc --noEmit

# One test file, from its package directory
npx vitest run <file>

# The scripts project, from the repo root (also `npm run test:scripts`)
npx vitest run --project scripts
```

### Styling

Inline `style={{}}` backed by design tokens from `web/src/styles/tokens.ts` (`color`, `radius`, `fontSize`, `fontWeight`, `shadow`). ESLint blocks raw hex colors and raw `borderRadius`/`fontSize`/`fontWeight` values. Spacing (padding, margin, gap) is intentionally NOT tokenized — use raw numbers.

**Color modes.** The app has light and dark modes, chosen per browser in Profile → Preferences (System, the default, follows the device). In the web build each `color` token is a CSS variable (`color.textPrimary` is `var(--fv-text-primary)`), defined for both modes in a `<style>` that `web/vite.config.ts` writes into `index.html`; dark mode is the `dark` class on `<html>`. `shared/tokens.ts` keeps the literal light values, which the API's emails use. Shared modules that import it (chip colors, event lines, mention pills) get the variables when bundled into the web app. That swap is a Vite resolve plugin in `web/vite.config.ts`: it applies only to imports from inside `shared/`. Web code imports `web/src/styles/tokens.ts`, never `shared/tokens.ts` directly, or it gets light-only literals.

To add a color token, add its light value to `color` in `shared/tokens.ts` and its dark value to `darkColor` in `web/src/styles/colorModes.ts` (TypeScript requires both). In dark mode, tinted fills go dark and text goes light; put text on a colored fill in `textOnFill`, never `white`, which is the card surface. If it's a text color, add its pair to the contrast test in `web/src/styles/tokens.test.ts`. In SVG, set colors through `style`, not the `fill`/`stroke` attributes, so the variable resolves.

Brand colors in dark mode: Honey (`accentAmber`, `#e8a33d`) is the same in both modes, because it fills the logo mark, which is never recolored. The wordmark's "Floor" (`wordmarkFloor`) is navy on the light page and white on the dark one, the brand's on-dark lockup, as on the navy sidebar. The legacy amber `#f59e0b` is retired in both palettes. `web/src/styles/themeLiterals.test.ts` fails on raw hex, white text, or faint black hover fills in app code.

Material Symbols icons use an explicit allowlist in `web/index.html` — add new icons to the `icon_names=` query param before using them. Unregistered icons silently render as their literal name text.

### Explanations

`InfoTooltip` (ⓘ) is for explaining how FloorVote works: what a field does, who can change it, where data comes from. Explanations of legislative or data terms (a status, a bill type, a provider's field label) go on the term itself, opening above (below only where there is no room above), with no ⓘ. A term that only restates its label, or defines a generic concept (an event type such as a hearing), gets no hover. Use `HoverTooltip` (`web/src/components/HoverTooltip.tsx`) with its `describe` option for those: the term becomes a dotted-underlined toggletip button like the ⓘ (hover and focus preview it, click, tap, Enter, or Space pins it open or closed, Escape closes it), with a screen-reader copy of the text, opening above by default. The cursor is the pointer, never `help`. A chip or other control that is already interactive passes `describe={{ interactive: true }}` and keeps its own click, with no underline. A dotted underline always means this: a trigger with a dotted underline is a button that opens on click or tap, never a hover-only span. For a rich panel rather than a sentence (the change log), pass `toggletip` with the underlined text as the child instead of `describe`.

### Navigation

In-app page transitions hold the current page with a wait cursor while the destination loads, then swap. Never show a full-page spinner during navigation.

Route loaders must use `apiFetchForLoader` (not raw `apiFetch`) — a raw 401 bypasses auth and crashes the app.

### Rules

1. Import colors/radii/font sizes from `web/src/styles/tokens.ts`. Spacing is raw numbers.
2. Register Material Symbols icons in `icon_names=` in `web/index.html` before use.
3. Never edit existing migration files — create new ones.
4. Timestamps: `datetime('now')` in SQL, never ISO. Frontend: `feedTsToEpoch`. A `new Date().toISOString()` that is never stored needs a same-line `// ts-write-ok: <reason>`. The guard `scripts/verify-timestamp-writes.ts` enforces this in CI; run it locally with `npm run verify:timestamps` (see `docs/internal/dates.md`).
5. Relevance scores are 1–10, not 0–100.
6. Tenants never call legislative APIs directly — all data flows through central.
7. Use `apiFetchForLoader` in route loaders, not raw `apiFetch`.
8. Every color works in both light and dark mode: use a token, never a literal. No full-page spinners on navigation.
9. Never run `wrangler deploy` directly — use `npm run deploy:tenant`.
10. Don't mock D1 in tests — use real @cloudflare/vitest-pool-workers bindings.
11. Don't leave `web/dist` around during local dev — it breaks the Vite `/api` proxy.
12. Stub `fetch` per test with `stubFetch` (`api/test/helpers.ts`). An unstubbed request fails the test and names its URL (`api/test/setup.ts`).
13. Send requests that start background work (`ctx.waitUntil`, such as email) through `appFetch`, not `SELF.fetch`. The work then finishes, and a failure in it fails the test.

### Conventions

- **Working in a fork.** If your checkout carries operator-specific files not tracked upstream (e.g. deploy configs, an internal ops runbook), decide up front whether a change belongs upstream or stays fork-only before creating a worktree or branch — see [Forking and operator overlays](https://floorvote.org/docs/contributing/#forking-and-operator-overlays).
- **Button labels.** A label ends in a single ellipsis character (`…`) when its click opens a step that asks for input or a choice, or shows something new, before the action happens ("Feedback…" opens a form). A confirmation that only warns does not count, since the label already says what will happen ("Delete role" keeps its plain label); if a confirmation would reveal something new, show it beside the button instead, as the bulk bar does with its AI analysis count.

## graphify

If `graphify-out/graph.json` exists, run `graphify query "<question>"` before grepping source files.
