---
description: "Run a public, no-signup FloorVote instance by deploying a tenant with DEMO_MODE enabled, and choose which bills and content the demo shows."
---

# Public demo site (optional)

Most deployments don't need this — **skip this page and every tenant is a normal, sign-in-required instance.**

A "demo site" is just a regular tenant deployed with one extra var, `DEMO_MODE = "true"` (in `[env.<id>.vars]` in `api/wrangler.toml`), and a reset cron. The flag turns the tenant into a public, no-signup showcase:

- **Auto-login.** Visitors without a session are silently signed in as a shared demo user — no magic link.
- **No outbound email.** Digests and notifications are never sent from a demo tenant.
- **Additive actions only.** Visitors can comment, vote, react, take notes, and set priorities, positions, and custom fields. Destructive and admin actions are refused. See [What a visitor can change](#what-a-visitor-can-change) below.
- **Reset every six hours.** A cron at 00:00, 06:00, 12:00, and 18:00 UTC resets and re-seeds the tenant to a known state. You add that cron yourself (see below). You can also trigger a reset by hand with `POST /api/internal/demo-reset`.

To run one, deploy a tenant as in [Adding tenants](/self-hosting/tenants), with `DEMO_MODE = "true"` added to its vars (see [Choosing the demo content](#choosing-the-demo-content) for what else the seed controls). Change one thing in its config block: replace the two crons in `[env.<id>.triggers]` with the reset cron, because a demo tenant never sends digests or re-runs AI, and any cron it receives runs the reset.

```toml
[env.<id>.triggers]
crons = ["0 0,6,12,18 * * *"]
```

To not run a demo, just leave `DEMO_MODE` out.

## What a visitor can change

A demo is a showcase, and a showcase nobody can touch reads like a screenshot. So a `DEMO_MODE` tenant accepts the **additive member actions** — post a comment, edit your own, cast or clear a vote, react, write a personal note, set a bill's priority or official position, fill in a custom field, dismiss a single new match — and refuses everything else. Visitors share one login, so a destructive action would leave the demo broken for the next visitor until the reset; an additive one is just the product working.

The server is the enforcement point. `DEMO_WRITE_ALLOWLIST` in `api/src/middleware/auth.ts` names every permitted method-and-path, the guard refuses every other non-GET request under `/api/` regardless of who is signed in (superadmins included), and a test fails if any registered route is neither allowed nor explicitly denied. The app disables the matching controls so a visitor sees the state rather than an error; admin controls carry a "Locked in demo mode" tooltip alongside an in-page notice.

Because auto-login hands every visitor a session with no interaction, those writes are anonymous by construction, so two limits sit behind them: allowed writes are rate-limited per client IP (the optional `DEMO_WRITE_RATE_LIMITER` binding — see `api/wrangler.example.toml`; without it the check fails open), and any one bill accepts at most 60 live comments. A visitor never meets either — the busiest seeded bill carries 8 comments — but together they keep a script from growing the tenant between resets. Reactions need no such limit: a reaction must be one of the eight emojis the picker offers, so the chips one comment can carry are bounded at eight by construction.

Reads have no limit in the app: the guard passes every `GET` straight through, so a script looping over bill texts, exports, or filtered lists is never metered. If your demo is public, add a Cloudflare [rate limiting rule](https://developers.cloudflare.com/waf/rate-limiting-rules/) scoped to the demo's hostname. It runs before the Worker, so a blocked request costs nothing. Keep it generous: one page load fans out to about ten API calls, and a group demo from one office shares one IP, so something like 300–600 requests a minute per IP fits. On the Free plan that's 50–100 requests per 10 seconds, the only counting period offered. Scope the rule to the demo's hostname rather than turning on zone-wide Bot Fight Mode, which on the Free plan challenges every non-browser client in the zone. That includes the calendar apps polling your other tenants' iCal feeds and the link-preview fetchers that unfurl shared links.

Refused: deleting comments, inviting or removing members, creating or renaming roles, bill-list bulk actions, calendar event creation, edits, deletion, restore, import and subscribe, draft-bill editing and link-and-merge, account deactivation and deletion, and logout.

Two deliberate exceptions to the pattern:

- **Module toggles still work.** The sidebar's **Customize widgets** panel — the admin-only link pinned above the user section — is live, so visitors can turn the optional widgets on and see what they do. The reset puts them back to the seeded state.
- **The Feedback link is hidden, not disabled.** It's the one control removed outright rather than greyed out — a shared demo login can't produce feedback anyone could act on.

## Choosing the demo content

The demo's content — its personas, county names, comments, calendar events, keywords, AI context, and tag taxonomy — is data, described by a *seed*. Seeds live in `api/src/lib/demoSeeds/`, one module each, and are registered in `api/src/lib/demoSeeds/index.ts`. `api/src/lib/demoReset.ts` is the machinery that writes a seed to the database; it holds no content of its own.

`DEMO_SEED` picks which seed a tenant uses, by registry key:

```toml
DEMO_MODE = "true"
DEMO_SEED = "lake-michigan"
```

Leave `DEMO_SEED` out and the tenant gets `lake-michigan`, a Great Lakes water policy team tracking bills across Michigan, Wisconsin, Illinois, Indiana, and Congress. It is the only seed that ships. An unrecognized value fails the reset loudly rather than falling back, so a tenant pinned to a seed that no longer exists stops resetting until you change or remove `DEMO_SEED`.

The seed writes `ai_context`, `relevance_question`, `tag_taxonomy`, and `keywords` itself on every reset, so a demo tenant's content comes entirely from its seed module — there's no separate configuration step.

A seed also carries the team field changes its bills show as activity lines in the comment thread: who set a priority, official position, or custom field, from what to what, and how many days ago. Every reset deletes all of a demo's field changes, including the ones visitors made by changing a priority, position, or custom field, and writes the seed's back, so a thread never keeps a line about a change the page no longer shows. The reset also deletes the `grouped` and `split` events that record companion groups, so a demo shows no grouping line: such a line is dated when the group formed, while the seeded comments are re-dated on every reset, so it would drift out of step with them and then vanish. The groups themselves are not touched. Write each field's changes so its newest one ends on the value the seed sets for it. A change on a bill the tenant doesn't have is skipped, like the rest of a seed's bill rows.

A seed can also engage the companion side of a group. Lake Michigan carries comments, reactions, member votes, and a note on the identical companions of four tracked bills (Wisconsin AB131 and SB56, and the federal HB284 and HB6668), so once those companions are delivered into the tenant, each group's page shows comments from both bills in one thread, the line that says comments and votes are shared with the companion, and the companion badges. Until a companion is in the tenant, its rows are skipped, like the rest of a seed's bill rows. A demo also hides the title-matched suggestion, the line an admin's bill page shows when another bill looks like a companion, so a reset never leaves one for a visitor to act on.

A seed also carries its saved views, three named bill-list filters written for that demo's audience. The view switcher shows nothing on an instance with no views, so without them a visitor would never see the feature. Every reset deletes all of a demo's saved views and writes the seed's back, so a view added, changed, or removed between resets does not survive. Each view stores the bill list's own query string, and each combines several filters the way a team would (for example, a custom field plus an official position). At most one is an OR view: `match=any` across two or more filter dimensions, the OR group operator. Write views from what the seed itself installs (priorities, positions, custom field values), so each returns bills whatever the AI tagged. Do not filter on a subject: a seed writes none, a bill page shows subjects as the legislature's, and an operator can hide them for a whole tenant. A test checks that every view returns at least one bill, that each dimension of the OR view does on its own, and that no view uses a subject.

### Adding another demo

1. Copy the `lakeMichigan/` folder in `api/src/lib/demoSeeds/` to a new folder and edit it. It exports a `DemoSeed`: the type is the contract, and its comments explain the conventions (day offsets, timestamp format, mention markup, saved views). The seed's `slug` is the key operators will type.
2. Register it in `DEMO_SEEDS` in `api/src/lib/demoSeeds/index.ts` under that key.
3. Choose its scope. A multi-state seed lists its states in `stateCoverage`, as Lake Michigan does. A single-state seed sets `stateCoverage: null` and relies on the tenant's `STATE` var, and the reset then writes no coverage list.
4. Deploy the tenant with `DEMO_MODE = "true"` and `DEMO_SEED = "<your key>"` in its vars.

## Wiring a demo site into the deploy smoke check

The central deploy ends with an optional post-deploy smoke check (`smoke:legiscan`) that exercises the bill-text path end to end through the tenant-to-central binding — the one path that quietly returns 403 if the deny-by-default surface (`central/src/lib/tenantSurface.ts`) is missing an allowlist entry. It's **opt-in via `SMOKE_BASE_URL`**:

- **`SMOKE_BASE_URL` unset (the default)** → the check is skipped (exit 0). A deployment without a demo site won't fail its deploy here.
- **`SMOKE_BASE_URL` set to a `DEMO_MODE` tenant** (inline in the `smoke:legiscan` script, or exported by your deploy environment) → the check runs against it. A demo tenant is the easiest target because its shared auto-login session needs no cookie. To probe a normal tenant instead, also set `SMOKE_COOKIE` to a valid session cookie.
