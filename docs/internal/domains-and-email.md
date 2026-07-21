# Domains and email vars (detail)

> Moved out of the public self-hosting docs, where the essential action (set `APP_DOMAINS` and `EMAIL_FROM` in the tenant env block) is all a self-hoster needs. This page keeps the finer nuance for maintainers.

Two per-tenant vars (in the tenant's `[env.*.vars]`, see `api/wrangler.example.toml`) make a deployment domain-agnostic:

- **`APP_DOMAINS`** — comma-separated registrable domains this deployment serves. Drives cross-subdomain CORS and the superadmin SSO cookie scope.
  - Set **one** domain for a normal single-host deployment.
  - **Leave it unset** if you serve a single host or a bare `*.workers.dev` URL — that yields same-origin-only CORS and a host-only login cookie, which is correct for one host.
  - List **two** domains (comma-separated) only while migrating from an old domain to a new one: serving both lets existing sessions keep working (session cookies are host-only, so a redirect would otherwise force re-login). Drop back to one after the cutover.
- **`EMAIL_FROM`** — the full sender address for magic-link and notification email, e.g. `notifications@example.org`. Sending always requires a **verified** domain (a `*.workers.dev` host cannot send), independent of where the app is served. Unset falls back to a default sender address. Optional `EMAIL_REPLY_TO` defaults to `EMAIL_FROM`.
