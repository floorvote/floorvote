# Turnstile + login rate limiting (operator setup)

This covers the two abuse controls on the unauthenticated login POSTs
(`POST /api/auth/magic-link` on each tenant, `POST /admin/dash/auth/login` on
central): a per-IP **rate limit** (already active) and a **Turnstile** human-check
(shipped as an inert stub — you activate it).

Both protect the same endpoints. The per-user / per-address active-link caps that
already existed are keyed on the *email*, so they can't stop a flood across many
different addresses from one source; these per-IP controls close that gap
.

## 1. Rate limiting — already active, nothing to do

Each worker has a Workers Rate Limiting binding `LOGIN_RATE_LIMITER`
(`[[env.<id>.ratelimits]]` in `api/wrangler.toml`; `[[env.legiscan.ratelimits]]`
in `central/wrangler.toml`): **10 requests / 60s per client IP** per login
endpoint. Over the limit returns `429`. The code (`shared/rateLimit.ts`) **fails
open** if the binding is ever absent (local dev, tests) — it never locks users
out on a limiter blip. To tune, edit the `limit` / `period` (`period` must be
`10` or `60`) in the `[env.<id>.ratelimits.simple]` block and redeploy.

## 2. Turnstile

Turnstile is fully enabled on both login surfaces. The server gate
(`shared/turnstile.ts`) verifies the token on `POST /api/auth/magic-link`
(tenants) and `POST /admin/dash/auth/login` (central); the login forms render the
widget and send the token (`web/src/pages/Login.tsx` + `web/src/components/Turnstile.tsx`,
and the central `web/` equivalents). The secret is the `TURNSTILE_SECRET_KEY`
worker secret, set on all tenants + central.

**The public sitekey is config-driven** (not hardcoded). Each worker exposes it
via the `TURNSTILE_SITE_KEY` **var** (`[env.<id>.vars]` in `api/wrangler.toml` /
`[env.legiscan.vars]` in `central/wrangler.toml`), served to the login form over a
public bootstrap endpoint — tenants via `GET /auth/demo-mode`
(`{ turnstileSiteKey }`), the dashboard via `GET /admin/dash/auth/config`. The
form renders the widget **only when the var is set**; unset → no widget (fail-open,
mirroring the secret gate). Set this to your own Turnstile sitekey on each tenant and central legiscan.
(Local `dev` deliberately leaves it unset so local login needs no challenge.)
See the self-hosting guide (`docs/content/self-hosting/index.md`) for setup instructions.

Gate semantics (`shared/turnstile.ts`): secret **unset** → fails **open** (login
works without a token); secret **set** → fails **closed** (missing/invalid token
or a siteverify outage → `403`). To disable Turnstile, delete the secret
(`wrangler secret delete TURNSTILE_SECRET_KEY --env <id>`) — the gate reverts to
fail-open instantly, no redeploy.

> **Rollout order:** because the gate
> fails closed once the secret is set, setting the secret *before* the frontend
> sends a token 403s every new login. Order is: deploy the widget-bearing
> frontend first, *then* set the secret. (We hit this; it's why this note exists.)

### A. Create the Turnstile widget — done

Widget created in the Cloudflare dashboard. **A hostname authorizes all of its
subdomains**, so listing `example.com` covers every tenant + the dashboard
— and any future `*.example.com` tenant needs no widget change. Just keep your
registrable domain on the list, plus `localhost` for dev.

### B. Set the secret on every worker

```bash
# tenants (from api/) — list your tenant env names
for e in my-org demo; do wrangler secret put TURNSTILE_SECRET_KEY --env "$e"; done
# central dashboard (from central/)
wrangler secret put TURNSTILE_SECRET_KEY --env legiscan
```

### C. The frontend widget — already implemented

The login forms already render the Turnstile widget (when a **site key** is
configured) and POST the resulting token as **`turnstileToken`** in the JSON
body. No frontend work is needed here — it ships in the codebase:

- Tenant login page → `POST /api/auth/magic-link` body `{ email, turnstileToken }`
  (see `web/src/components/Turnstile.tsx` + `web/src/pages/Login.tsx`).
- Central dashboard login → `POST /admin/dash/auth/login` body
  `{ email, turnstileToken }` (`central/web/`).

The only operator step is the public **site key**: set `TURNSTILE_SITE_KEY` (a
var, not a secret) on each worker. The widget renders only when it is present.
The server reads `body.turnstileToken` and the client IP (`CF-Connecting-IP`) and
calls siteverify.

### D. Roll out

Deploy frontend (with the widget) **first**, then set the secret (step B). Verify
a real login still works end to end on staging before prod.

## Rollback

Delete the secret to instantly disable Turnstile (gate reverts to fail-open):
`wrangler secret delete TURNSTILE_SECRET_KEY --env <id>`. The rate limiter is
independent and stays active.
