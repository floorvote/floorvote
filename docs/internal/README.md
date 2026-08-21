# FloorVote internal docs

These pages are **not** part of the published docs site (`floorvote.org/docs`). They live in the repository for contributors and feature-adding coding agents, and hold the technical depth that's too detailed for the public pages.

Rule: relocate technical depth here — don't delete it.

The two interactive HTML companions are the exception: GitHub renders `.html` as source, so they live in `docs/content/public/internal/` and are served as standalone pages at `floorvote.org/docs/internal/`. They are not sidebar pages, and the markdown here remains the source of truth.

| File | What it covers |
|---|---|
| `sync-pipeline.md` | Code-grounded LegiScan → tenant sync pipeline (cron, ingestor, dedup, queues). |
| `legiscan-api.md` | LegiScan API reference (machine-derived from the LegiScan manual PDF). |
| `emails.md` | The email-shell contract — follow it when adding an email type. |
| `calendar.md` | ICS calendar feed capability-URL security model. |
| `turnstile.md` | Turnstile and login rate-limiting internals. |
| `style-tokens.md` | Style-token consolidation decisions. |
| `dates.md` | Date and time storage and display convention. |
| `domains-and-email.md` | `APP_DOMAINS` / `EMAIL_FROM` nuance (CORS, cookie scope, domain migration). |
| `tenant-automation.md` | What can and can't be scripted when adding a tenant (agent-facing). |
| `legiscan-notes.md` | LegiScan operational + licensing notes (quota, `skipFetch`, attribution). |
| `rebranding.md` | Renaming resources via `RESOURCE_PREFIX` for forks. |

## Previewing the docs site locally

Neither command publishes — only `wrangler deploy` and the deploy scripts do.

- Content, with hot reload: `npm run docs:dev`, then open localhost:5173/docs/.
- The Worker actually serving the built assets: `npm run docs:build`, then `npx wrangler dev -c docs/wrangler.toml`, then open localhost:8788/docs/. Use this one to check routing and `not_found_handling`, which the dev server does not model.
- Deploy: `npm run docs:deploy`. It builds and deploys the `floorvote-docs` Worker, which registers the `/docs` and `/docs/*` routes on the floorvote.org zone.
