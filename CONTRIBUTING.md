# Contributing to FloorVote

## Local development

Prerequisites: Node.js 22+, npm.

```bash
# Install dependencies (root manages api/ and web/ workspaces; central/ is standalone)
npm install
cd central && npm install

# One-command seeded local dev — fresh D1, auto-login, api(8787) + web(5173)
npm run dev:local

# Or run api + web together without seeding
npm run dev
```

Open http://localhost:5173. With `dev:local`, login is automatic (demo mode).

## Running tests

```bash
cd api && npm test       # tenant worker tests (vitest + @cloudflare/vitest-pool-workers)
cd central && npm test   # central worker tests
cd web && npm test       # frontend tests (vitest + jsdom)
```

API and central tests use real D1 bindings — no mocked databases.

## Coding conventions

See the [Developing](AGENTS.md#developing) section in AGENTS.md for the full rules. Key points:

- **Inline styles with design tokens** from `web/src/styles/tokens.ts` — no raw colors or font sizes
- **Register new Material Symbols icons** in `web/index.html` before using them
- **New migration files only** — never edit existing ones
- **Timestamps** in SQLite space-format UTC, never ISO

## Pull requests

- Keep changes focused — one feature or fix per PR.
- Run `npm test` in `api/`, `central/`, and `web/` before submitting.
- Run `npm run build` from `web/` to catch type errors (vitest does not run `tsc`).
- Describe what changed and why in the PR body.
