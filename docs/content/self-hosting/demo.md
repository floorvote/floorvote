# Public demo site (optional)

Most deployments don't need this — **skip this page and every tenant is a normal, sign-in-required instance.**

A "demo site" is just a regular tenant deployed with one extra var, `DEMO_MODE = "true"` (in `[env.<id>.vars]` in `api/wrangler.toml`). That one flag turns the tenant into a public, no-signup showcase:

- **Auto-login.** Visitors without a session are silently signed in as a shared demo user — no magic link.
- **No outbound email.** Digests and notifications are never sent from a demo tenant.
- **Additive actions only.** Visitors can comment, vote, react, take notes, and set priorities, positions, and custom fields. Destructive and admin actions are refused. See [What a visitor can change](#what-a-visitor-can-change) below.
- **Reset every six hours.** A cron at 00:00, 06:00, 12:00, and 18:00 UTC resets and re-seeds the tenant to a known state. You can also trigger it by hand with `POST /api/internal/demo-reset`.

To run one, deploy a tenant exactly as in [Adding tenants](/self-hosting/tenants), with `DEMO_MODE = "true"` added to its vars — but leave `INSTANCE_PRESET` out (see [Choosing the demo content](#choosing-the-demo-content)). To not run one, just leave `DEMO_MODE` out.

## What a visitor can change

A demo is a showcase, and a showcase nobody can touch reads like a screenshot. So a `DEMO_MODE` tenant accepts the **additive member actions** — post a comment, edit your own, cast or clear a vote, react, write a personal note, set a bill's priority or official position, fill in a custom field, dismiss a single new match — and refuses everything else. Visitors share one login, so a destructive action would leave the demo broken for the next visitor until the reset; an additive one is just the product working.

The server is the enforcement point. `DEMO_WRITE_ALLOWLIST` in `api/src/middleware/auth.ts` names every permitted method-and-path, the guard refuses every other non-GET request under `/api/` regardless of who is signed in (superadmins included), and a test fails if any registered route is neither allowed nor explicitly denied. The app disables the matching controls so a visitor sees the state rather than an error; admin controls carry a "Locked in demo mode" tooltip alongside an in-page notice.

Because auto-login hands every visitor a session with no interaction, those writes are anonymous by construction, so two limits sit behind them: allowed writes are rate-limited per client IP (the optional `DEMO_WRITE_RATE_LIMITER` binding — see `api/wrangler.example.toml`; without it the check fails open), and any one bill accepts at most 60 live comments. A visitor never meets either — the busiest seeded bill carries 8 comments — but together they keep a script from growing the tenant between resets. Reactions need no such limit: a reaction must be one of the eight emojis the picker offers, so the chips one comment can carry are bounded at eight by construction.

Refused: deleting comments, inviting or removing members, creating or renaming roles, bill-list bulk actions, calendar event creation, edits, deletion, restore, import and subscribe, draft-bill editing and link-and-merge, account deactivation and deletion, and logout.

Two deliberate exceptions to the pattern:

- **Module toggles still work.** The sidebar's **Customize widgets** panel — the admin-only link pinned above the user section — is live, so visitors can turn the optional widgets on and see what they do. The reset puts them back to the seeded state.
- **The Feedback link is hidden, not disabled.** It's the one control removed outright rather than greyed out — a shared demo login can't produce feedback anyone could act on.

## Choosing the demo content

The demo's content — its personas, county names, comments, calendar events, keywords, AI context, and tag taxonomy — is data, described by a *seed*. Seeds live in `api/src/lib/demoSeeds/`, one module each, and are registered in `api/src/lib/demoSeeds/index.ts`. `api/src/lib/demoReset.ts` is the machinery that writes a seed to the database; it holds no content of its own.

`DEMO_SEED` picks which seed a tenant uses, by registry key:

```toml
DEMO_MODE = "true"
DEMO_SEED = "nj-county-clerks"
```

Leave `DEMO_SEED` out and the tenant gets `nj-county-clerks`, the New Jersey county clerks seed. An unrecognized value fails the reset loudly rather than falling back.

**Leave `INSTANCE_PRESET` unset on a demo tenant.** The seed writes `ai_context`, `relevance_question`, `tag_taxonomy`, and `keywords` itself, so a preset has nothing to add and the two would be competing for the same four keys. (The worker ignores `INSTANCE_PRESET` when `DEMO_MODE = "true"`, so setting it does no damage — but it's noise in the config, and the reset deletes any `instance_preset` row it finds.)

### Adding a second demo

1. Add a seed module beside `njCountyClerks.ts` in `api/src/lib/demoSeeds/`, exporting a `DemoSeed`. Copy the existing one — the type is the contract, and its comments explain the conventions (day offsets, timestamp format, mention markup).
2. Register it in `DEMO_SEEDS` in `api/src/lib/demoSeeds/index.ts` under the key you want operators to type.
3. Deploy the tenant with `DEMO_MODE = "true"` and `DEMO_SEED = "<your key>"` in its vars.
4. Leave `INSTANCE_PRESET` unset.

## Wiring a demo site into the deploy smoke check

The central deploy ends with an optional post-deploy smoke check (`smoke:legiscan`) that exercises the bill-text path end to end through the tenant-to-central binding — the one path that quietly returns 403 if the deny-by-default surface (`central/src/lib/tenantSurface.ts`) is missing an allowlist entry. It's **opt-in via `SMOKE_BASE_URL`**:

- **`SMOKE_BASE_URL` unset (the default)** → the check is skipped (exit 0). A deployment without a demo site won't fail its deploy here.
- **`SMOKE_BASE_URL` set to a `DEMO_MODE` tenant** (inline in the `smoke:legiscan` script, or exported by your deploy environment) → the check runs against it. A demo tenant is the easiest target because its shared auto-login session needs no cookie. To probe a normal tenant instead, also set `SMOKE_COOKIE` to a valid session cookie.
