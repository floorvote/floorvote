# FloorVote internal docs

These pages are **not** part of the published docs site (`floorvote.org/docs`). They live in the repository for contributors and feature-adding coding agents, and hold the technical depth that's too detailed for the public pages.

Rule: relocate technical depth here — don't delete it.

| File | What it covers |
|---|---|
| `sync-pipeline.md` | Code-grounded LegiScan → tenant sync pipeline (cron, ingestor, dedup, queues). |
| `legiscan-api.md` | LegiScan API reference (machine-derived from the LegiScan manual PDF). |
| `sync-flow.html` | Interactive companion diagram to `sync-pipeline.md`. |
| `architecture.html` | Interactive architecture dossier (mermaid). |
| `emails.md` | The email-shell contract — follow it when adding an email type. |
| `calendar.md` | ICS calendar feed capability-URL security model. |
| `turnstile.md` | Turnstile and login rate-limiting internals. |
| `style-tokens.md` | Style-token consolidation decisions. |
| `dates.md` | Date and time storage and display convention. |
