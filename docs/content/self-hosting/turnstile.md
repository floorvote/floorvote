# Turnstile (optional login protection)

Every login form already has an always-on, per-IP rate limiter. On top of that, you can add a [Cloudflare Turnstile](https://developers.cloudflare.com/turnstile/) human-check on the login screens. It's **optional and off by default** — skip this page entirely and login still works.

Turnstile protects the unauthenticated login requests (`POST /api/auth/magic-link` on each tenant, and `POST /admin/dash/auth/login` on the central dashboard). It has two halves, both set through configuration — no code changes:

1. **Public sitekey** — a `TURNSTILE_SITE_KEY` **var** on each worker (`[env.<id>.vars]` in `api/wrangler.toml`, `[env.legiscan.vars]` in `central/wrangler.toml`). The login form shows the widget **only when this is set**; unset means no widget.
2. **Secret key** — the `TURNSTILE_SECRET_KEY` worker **secret**. The server checks the token only when this is set (and then fails closed: a missing or invalid token returns a 403). Unset means the check is skipped.

## Setup

```bash
# 1. Create a Turnstile widget in the Cloudflare dashboard. On the widget, list your
#    registrable domain (one hostname covers all its subdomains) plus `localhost`.
#    Note the sitekey (public) and the secret key.

# 2. Add the sitekey var to each worker that should show the widget, e.g.
#    api/wrangler.toml:      [env.org-nj.vars]    TURNSTILE_SITE_KEY = "0x...."
#    central/wrangler.toml:  [env.legiscan.vars]  TURNSTILE_SITE_KEY = "0x...."

# 3. Set the secret on each worker (tenants from api/, dashboard from central/):
wrangler secret put TURNSTILE_SECRET_KEY --env org-nj
wrangler secret put TURNSTILE_SECRET_KEY --env legiscan   # dashboard
```

> **Order matters.** Because the check fails closed once the secret is set, setting the secret *before* the login form is sending a token will 403 every login. Deploy the sitekey-bearing frontend **first**, then set the secret.

To turn Turnstile off later, delete the secret — the check reverts to "skipped" instantly, no redeploy needed:

```bash
wrangler secret delete TURNSTILE_SECRET_KEY --env org-nj
```

The full maintainer reference lives in `docs/internal/turnstile.md` in the repository.
