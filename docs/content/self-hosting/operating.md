# Operating your deployment

Once your central service and at least one tenant are running, this page covers the day-to-day: optional central features you can turn on, growing your deployment, and keeping it up to date. None of this is required to get running — see [Self-hosting](/self-hosting/) and [Adding tenants](/self-hosting/tenants) for the must-do path.

## Optional: superadmin dashboard

The LegiScan central can serve a superadmin dashboard with its own magic-link login and cross-domain single sign-on. It's optional — central works fine without it. To turn it on, set these secrets on central (run from inside `central/`):

```bash
# Magic-link email for the dashboard
wrangler secret put RESEND_API_KEY --env legiscan

# ES256 private JWK (JSON string); central is the sole issuer
wrangler secret put SUPERADMIN_JWT_PRIVATE_KEY --env legiscan

# Comma-separated list of superadmin email addresses
wrangler secret put SUPERADMIN_EMAILS --env legiscan
```

Generate an ES256 keypair with any JWK tool. Central holds the private half; each tenant verifies with the matching **public** JWK, which is not a secret — it goes in each tenant's `[env.*.vars]` as `SUPERADMIN_JWT_PUBLIC_KEY` (see the tenant env block in [Adding tenants](/self-hosting/tenants)).

## Optional: observability panels

These power the operations dashboards and the Members "Login activity" panel. Each one quietly does nothing when its credentials are unset — no crash, the feature just stays dark.

`CF_ANALYTICS_TOKEN` covers two separate features and needs one permission for each — both can live on the same token:

- **D1 anomaly watch** — needs the `CF_ACCOUNT_ID` **var** (set in `[env.legiscan.vars]`, not a secret) plus a token with **Account → D1: Read**.
- **Login Activity delivery status** — a zone-level lookup, so it needs **Zone → Analytics: Read** on your app's zone, plus the zone's ID in the `CF_FLOORVOTE_ZONE_ID` **var** (also in `[env.legiscan.vars]` — this is the zone ID from your domain's Overview page in the Cloudflare dashboard, not the account ID). Skip this if you don't need delivery-status detail; the token still works for D1 anomaly watch with just the account permission.

```bash
# Cloudflare API token: Account "D1: Read" + Zone "Analytics: Read"
wrangler secret put CF_ANALYTICS_TOKEN --env legiscan

# Cloudflare API token, scoped: Email Sending: Read
wrangler secret put CF_EMAIL_TOKEN --env legiscan
```

## Adding a new state to an existing tenant

Update `state_coverage` in the tenant's `association_config`, then load that state's bills into central (see the seeding steps in [Adding tenants](/self-hosting/tenants#step-8-seed-the-active-session-s)). Central will then notify the tenant of any bills matching its keywords.

## Adding another tenant

Each new organization or topic focus is another tenant. Follow [Adding tenants](/self-hosting/tenants) again — you reuse the same account-level Cloudflare credentials every time, so the per-tenant work is small.

## Upgrading

Pull the latest code and redeploy. Always use the deploy scripts so migrations and the frontend build run:

```bash
git pull origin main
cd central && npm install && npm run deploy:legiscan

# Repeat for each tenant
cd ../api && npm run deploy:tenant -- org-nj
```

## Monitoring

Each tenant Worker exposes `GET /api/health`. On the LegiScan central, the health check is also `GET /api/health` (the bare `/health` path is served by the admin dashboard). The central worker pulls aggregate engagement stats from each tenant once a day, at 06:00 UTC.
