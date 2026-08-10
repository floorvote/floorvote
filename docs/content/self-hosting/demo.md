# Public demo site (optional)

Most deployments don't need this — **skip this page and every tenant is a normal, sign-in-required instance.**

A "demo site" is just a regular tenant deployed with one extra var, `DEMO_MODE = "true"` (in `[env.<id>.vars]` in `api/wrangler.toml`). That one flag turns the tenant into a public, no-signup showcase:

- **Auto-login.** Visitors without a session are silently signed in as a shared demo user — no magic link.
- **No outbound email.** Digests and notifications are never sent from a demo tenant.
- **Read-only.** The server refuses every write, and the app greys out the controls that would have made one. See [Read-only](#read-only) below.
- **Nightly reset.** A 06:00 UTC cron resets and re-seeds the tenant to a known state. You can also trigger it by hand with `POST /api/internal/demo-reset`.

To run one, deploy a tenant exactly as in [Adding tenants](/self-hosting/tenants), with `DEMO_MODE = "true"` added to its vars — but leave `INSTANCE_PRESET` out (see [Choosing the demo content](#choosing-the-demo-content)). To not run one, just leave `DEMO_MODE` out.

## Read-only

A demo is a showcase, not a sandbox: visitors share one login, so anything one of them changed would be there for the next. So a `DEMO_MODE` tenant refuses every write. The server is the enforcement point — it rejects non-GET requests regardless of who is signed in, superadmins included — and the app disables the matching buttons, menus, and fields so a visitor sees the state rather than an error. Disabled controls carry a "Read-only in demo mode" tooltip, and the demo banner across the top says the same thing in prose.

Two deliberate exceptions:

- **Module toggles still work.** Settings → Modules is live, so visitors can turn the optional widgets on and see what they do. The nightly reset puts them back to the seeded state.
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
