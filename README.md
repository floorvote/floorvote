<p align="center">
  <a href="https://floorvote.org">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset=".github/assets/floorvote-wordmark-dark.svg">
      <img alt="FloorVote" src=".github/assets/floorvote-wordmark.svg" width="360">
    </picture>
  </a>
</p>

<p align="center">
  <strong>Issue-based legislative tracking, for teams.</strong>
</p>

<p align="center">
  <a href="https://floorvote.org">floorvote.org</a>
</p>

---

FloorVote monitors state and federal legislation and surfaces the bills that matter to your team — filtered by configurable keywords, summarized by AI, and organized for collective review. Built initially for state associations of local election officials, it's designed to work for any team tracking any legislative issue.

Each organization gets a private, isolated deployment with its own database, member roster, bill list, and activity feed.

---

## Features

**Bill tracking**
- Hourly sync from LegiScan across all configured states
- Keyword-based filtering — only bills matching your issue area are ingested
- AI-generated summaries, tags, and relevance scores, tuned to your organization's context
- Full bill text stored and accessible (HTML and PDF)
- Deduplication — bills are only reprocessed when the provider signals a change

**Member engagement**
- Members vote support / oppose / neutral on individual bills
- Voting is semi-private: members see aggregates, admins see individual votes
- Comments with reactions
- Per-member bill notes
- Priority flags on bills
- Admin-defined custom fields per bill (binary, dropdown, text, date)

**Official positions**
- Admins record the organization's formal stance, separate from member votes
- The organization's self-noun (team, association, coalition, or custom) is configurable per deployment and drives the position-section and relevance labels

**User roles**
- Three system roles: owner, admin, member
- Custom organizational roles (e.g. committees) assignable to members
- Role-based vote filtering on bill detail pages
- Voting can be restricted by `canVote` flag per member

**Administration**
- Magic link auth — no passwords
- Invite members by email
- Configurable AI context, relevance question, and tag taxonomy per org
- Named presets bundle context + keywords for common issue areas (e.g. `election_officials`)
- Custom field definitions managed in admin settings

**Activity**
- Feed of recent bill additions, comments, votes, and position changes

---

## Architecture

```
Legislative API (LegiScan)
     ↓ (hourly cron)
Central Worker
  - fetches masterlist for each tenant-covered state
  - filters by per-state keyword union
  - stores full bill text in R2
  - fans out to per-tenant queues
     ↓ (per-tenant queue)
Tenant Worker (one per org)
  - runs AI: summary + tags + relevance
  - stores results in tenant D1
  - serves React SPA via Workers Assets
     ↕
Browser (React frontend)
```

Central handles all legislative API calls and stores bill text. Tenants never call LegiScan directly. AI processing is tenant-side only, using each org's configured context and taxonomy.

---

## Tech stack

| | |
|---|---|
| Backend | Hono on Cloudflare Workers — tenant API, central API |
| Database | Cloudflare D1 (SQLite via Drizzle ORM) — separate DBs for central and each tenant |
| Storage | Cloudflare R2 — bill text + masterlist cache stored centrally |
| Queues | Cloudflare Queues — central ingestor + per-tenant bill delivery |
| Frontend | React 19 + React Router 7 + Vite 8 — served via Workers Assets from each tenant Worker |
| Email | Cloudflare Email Service (magic link auth) |
| AI | Google Gemini 2.5 Flash via Cloudflare AI Gateway |
| Legislative data | LegiScan |

---

## Quick start

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full local development guide.

```bash
npm install
cd central && npm install

# One-command seeded local dev — fresh D1, auto-login, api(8787) + web(5173)
npm run dev:local
```

Open http://localhost:5173.

---

## Deployment

Each tenant is a separate Cloudflare Worker deployment. See [`docs/content/self-hosting/index.md`](docs/content/self-hosting/index.md) for the complete setup guide.

```bash
# Deploy a tenant (from api/)
npm run deploy:tenant -- <env-name>

# Deploy central (from central/)
npm run deploy:legiscan     # LegiScan central (recommended)
npm run deploy              # OpenStates central (experimental)
```

Configuration lives in `api/wrangler.toml` (per-tenant) and `central/wrangler.toml`. See the `*.example.toml` files for documented templates.

Never run `wrangler deploy --env <tenant>` directly — it skips migrations and the web build.

---

## Project structure

```
api/            Tenant Cloudflare Worker (one deployment per org)
  src/
    routes/     Hono route handlers
    lib/        LLM, email, keywords, taxonomy, presets
    config/     Runtime configuration helpers
    cron/       Tenant-side cron jobs
    middleware/ Auth, CORS, request middleware
    queue/      Bill processing (receives from per-tenant queue)
    db/         Drizzle schema + client
  migrations/   D1 migration SQL files
  test/

central/        Central Cloudflare Worker (shared ingestion layer)
  src/
    routes/     Bills API, tenant registration, admin endpoints
    lib/        Keyword union, masterlist cache, auth
    providers/  LegiScan + OpenStates API clients
    cron/       Hourly sync for tenant-covered states
    queue/      Ingestor (fetch + store + notify tenants)
    db/         Drizzle schema + client
  migrations/   D1 migration SQL files
  test/

web/            React frontend (built into tenant Worker via Workers Assets)
  src/
    pages/      Route-level components
    components/ Shared UI
    context/    React context providers (auth, config)
    hooks/      Custom hooks (auth, polling, UI utilities)
    lib/        Utility functions
    styles/     Design tokens + global CSS

shared/         Shared utility modules consumed by both api/ and web/
scripts/        Utility scripts (seeders, dev tooling)
legiscan/       LegiScan API reference and sample data
docs/           Architecture docs, self-hosting guide, conventions
```

---

## Acknowledgments

Architecture and security have been reviewed and strengthened through a volunteer engagement with [U.S. Digital Response](https://www.usdigitalresponse.org/) (volunteer: [Larry Hitchon](https://github.com/lhitchon)).

FloorVote is supported by the [Bipartisan Policy Center](https://bipartisanpolicy.org).
