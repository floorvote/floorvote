# Contributing to FloorVote

## Local development

Prerequisites: Node.js 22+, npm.

```bash
# Install dependencies (root manages api/ and web/ workspaces; central/ is standalone)
npm install
cd central && npm install

# Local secrets — copy the annotated example (every key is optional for demo dev)
cp api/.dev.vars.example api/.dev.vars
cp central/.dev.vars.example central/.dev.vars   # only if you work on central

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

## Forking and operator overlays

FloorVote is deployed per-organization — each instance is tied to a specific Cloudflare account, tenant domains, and secrets. Because of that, most forks accumulate an **operator overlay**: files like `wrangler.toml`, deploy scripts, and an internal ops runbook that are meaningful only to that operator's deployment and should never appear in this public repo. If you're forking to run your own instance, expect to build up the same kind of overlay. The guidance below is for sending a change from a fork like that back here.

**Decide the base before writing any code, not after.** If a change is general product code, it belongs upstream — branch from `upstream/main` for it, not your fork's `main`, from the start. Deciding this up front means the eventual PR is just a push and `gh pr create`; deciding only after building the feature on your fork's `main` means untangling the operator overlay from the change afterward.

```bash
git remote add upstream https://github.com/floorvote/floorvote.git   # once, if not already set up
git fetch upstream
git checkout -b <branch> upstream/main    # branch from UPSTREAM, not your fork's main
# implement the change, or `git cherry-pick <sha>` if it already exists as a commit on your fork's main
git push origin <branch>
gh pr create --repo floorvote/floorvote --head <your-org>:<branch> --base main
```

**Do this in a separate worktree, not by switching branches in place**, if your fork carries overlay files. Checking out an upstream-based branch in your primary checkout deletes every tracked file absent from that branch (e.g. your `wrangler.toml`) — nothing is lost since it's all still committed, but it breaks local dev/deploy until you switch back.

```bash
git worktree add ../floorvote-upstream upstream/main
cd ../floorvote-upstream
git checkout -b <branch>
# ... push, open the PR ...
cd -
git worktree remove ../floorvote-upstream
```

**Auditing what's genuinely fork-only:** use `git diff --stat upstream/main..main`, not `git log upstream/main..main` — the log over-reports (a fork commit stays listed even after its change reaches upstream via cherry-pick under a different SHA), while the diff shows the true net delta. Anything in that diff that's general product code, not operator config, is a candidate for a PR back here.

## Pull requests

- Keep changes focused — one feature or fix per PR.
- Run `npm test` in `api/`, `central/`, and `web/` before submitting.
- Run `npm run build` from `web/` to catch type errors (vitest does not run `tsc`).
- Describe what changed and why in the PR body.
