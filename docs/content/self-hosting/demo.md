# Public demo site (optional)

Most deployments don't need this — **skip this page and every tenant is a normal, sign-in-required instance.**

A "demo site" is just a regular tenant deployed with one extra var, `DEMO_MODE = "true"` (in `[env.<id>.vars]` in `api/wrangler.toml`). That one flag turns the tenant into a public, no-signup showcase:

- **Auto-login.** Visitors without a session are silently signed in as a shared demo user — no magic link.
- **No outbound email.** Digests and notifications are never sent from a demo tenant.
- **Nightly reset.** A 06:00 UTC cron resets and re-seeds the tenant to a known state (`api/src/lib/demoResetAndSeed.ts` is the single source of truth for the demo content). You can also trigger it by hand with `POST /api/internal/demo-reset`.

To run one, deploy a tenant exactly as in [Adding tenants](/self-hosting/tenants), with `DEMO_MODE = "true"` added to its vars. To not run one, just leave the flag out — there's nothing else to set.

## Wiring a demo site into the deploy smoke check

The central deploy ends with an optional post-deploy smoke check (`smoke:legiscan`) that exercises the bill-text path end to end through the tenant-to-central binding — the one path that quietly returns 403 if the deny-by-default surface (`central/src/lib/tenantSurface.ts`) is missing an allowlist entry. It's **opt-in via `SMOKE_BASE_URL`**:

- **`SMOKE_BASE_URL` unset (the default)** → the check is skipped (exit 0). A deployment without a demo site won't fail its deploy here.
- **`SMOKE_BASE_URL` set to a `DEMO_MODE` tenant** (inline in the `smoke:legiscan` script, or exported by your deploy environment) → the check runs against it. A demo tenant is the easiest target because its shared auto-login session needs no cookie. To probe a normal tenant instead, also set `SMOKE_COOKIE` to a valid session cookie.
