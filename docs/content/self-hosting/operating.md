---
description: "Day-to-day operation of a running FloorVote deployment: the optional superadmin dashboard, adding states, adding teams, upgrading, monitoring, and summary citations."
---

# Operating your deployment

Once your central service and at least one tenant are running, this page covers the day-to-day: optional central features you can turn on, growing your deployment, and keeping it up to date. None of this is required to get running — see [Self-hosting](/self-hosting/) and [Adding tenants](/self-hosting/tenants) for the must-do path.

## Optional: superadmin dashboard

The LegiScan central can serve a superadmin dashboard with its own magic-link login and cross-domain single sign-on. It's optional — central works fine without it. To turn it on, first make sure your `central/wrangler.toml` has the `[env.legiscan.assets]` block from the example (it tells Cloudflare to serve the dashboard SPA). Also set `ADMIN_APP_URL` (the dashboard's base URL, used in its sign-in links) and `EMAIL_FROM` (the sender address, on a domain you have verified) in `[env.legiscan.vars]`. Without `EMAIL_FROM` the mail goes out as `notifications@example.com`, which you won't have verified. Then set these secrets on central (run from inside `central/`):

```bash
# Magic-link email for the dashboard: only if central sends through Resend.
# Skip it when central uses Cloudflare Email (EMAIL_PROVIDER="cloudflare" with the EMAIL binding).
wrangler secret put RESEND_API_KEY --env legiscan

# ES256 private JWK (JSON string); central is the sole issuer
wrangler secret put SUPERADMIN_JWT_PRIVATE_KEY --env legiscan

# Comma-separated list of superadmin email addresses
wrangler secret put SUPERADMIN_EMAILS --env legiscan
```

Generate the keypair with `node scripts/gen-superadmin-keys.mjs` from the repository root, which prints both halves as JWK JSON. Central holds the private half; each tenant verifies with the matching **public** JWK, which is not a secret — it goes in each tenant's `[env.*.vars]` as `SUPERADMIN_JWT_PUBLIC_KEY` (see the tenant env block in [Adding tenants](/self-hosting/tenants)).

> [!WARNING]
> The dashboard login needs an email sender and `ADMIN_APP_URL`. Either sender is enough: Cloudflare Email (the `EMAIL` binding, which counts as a sender on its own; `EMAIL_PROVIDER = "cloudflare"` only makes it the first one tried) or `RESEND_API_KEY`. With both configured, the sign-in link falls back to the second when the first is down. If there is no sender or `ADMIN_APP_URL` is unset, signing in as a listed superadmin still answers "ok" but sends no email (central logs a warning naming what's missing), so it looks like the link never arrives.

### Superadmin profile

Each superadmin has one profile, a name and a title, kept in central and edited once on the dashboard's **Your profile** page. Central puts both in the sign-in token it issues. Each time a superadmin reaches a tenant through the dashboard, the tenant creates or overwrites its copy of their name and title from the token, so the same person appears the same way everywhere. A superadmin who signs in to a tenant directly by emailed link gets the same refresh: the tenant asks central, over its authenticated connection, for that one person's profile. The check and the lookup run in the background, so no one's sign-in waits on central, and the new name and title show on the superadmin's next page load. Central answers only for a superadmin, so the superadmin list stays private, and if central can't be reached the existing name and title stay. A saved change reaches a tenant the next time the superadmin signs in to it either way. The title doubles as the visible marker of operator staff, for example "Operator support."

On a tenant's Profile page, a superadmin's name and title are read-only, with a note that they're managed in the admin dashboard, and the tenant's API refuses edits to them. The note links to the dashboard's **Your profile** page once central has told the tenant where the dashboard lives (central sends its `ADMIN_APP_URL` with the hourly body-event sync, so there's nothing to set on the tenant), and stays plain text until then (and again if you unset `ADMIN_APP_URL`, which central reports as having no dashboard). A superadmin who has not saved a profile yet leaves each tenant's existing name and title alone.

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

`CF_EMAIL_TOKEN` lets central read Cloudflare's suppression list of addresses that bounced, and it also needs the `CF_ACCOUNT_ID` var. The list feeds the suppression banner on Login activity and the previously-bounced check when an admin bulk-invites members or changes a member's email. Without the token, those checks count only the bounces the instance itself recorded.

## Adding a new state to an existing tenant

Update `state_coverage` in the tenant's `association_config` (the same `INSERT OR REPLACE` as [Step 4b](/self-hosting/tenants#step-4b-seed-the-state-list-multi-state-teams-only)), and run `force-register` ([Step 8](/self-hosting/tenants#step-8-register-the-tenant-with-central)) so central hears about it now instead of at the tenant's next daily registration. Then load that state's bills into central (see the seeding steps in [Adding tenants](/self-hosting/tenants#step-12-seed-the-active-session-s)). Central will then notify the tenant of any bills matching its keywords.

## Adding another tenant

Each new organization or topic focus is another tenant. Follow [Adding tenants](/self-hosting/tenants) again — you reuse the same account-level Cloudflare credentials every time, so the per-tenant work is small.

## Deploying with GitHub Actions (optional)

The repo ships a manual deploy workflow at `.github/workflows/deploy.yml` (`workflow_dispatch` — it never fires on push). It wraps the same `npm run deploy:*` scripts this guide uses locally, so deploys run in CI instead of from your machine: auditable, and independent of any one laptop. Local `wrangler` still works and stays the fallback.

**One-time setup:**

1. Create a Cloudflare API token scoped to your account with **Workers Scripts: Edit**, **D1: Edit**, and **Queues: Edit** (add **Workers Routes: Edit** only if your deploys change routes). Add it as the repository secret `CLOUDFLARE_API_TOKEN` (repo → Settings → Secrets and variables → Actions).
2. Create a GitHub **Environment** named `production` (repo → Settings → Environments) and scope the token to it. Restrict its deployment branches to your default branch; on GitHub Team or Pro you can also require reviewer approval. Then uncomment the `environment: production` line in `.github/workflows/deploy.yml`. It ships commented out, and until it is on, the environment's restrictions and approvals don't apply to deploys.

**Deploying:**

```bash
# From your default branch — deploy one tenant, or central:
gh workflow run deploy.yml --ref main -f target=tenant -f tenant=<slug>
gh workflow run deploy.yml --ref main -f target=central-legiscan
gh run watch
```

Triggering with `gh` (or the Actions tab → "Deploy (manual)" → Run workflow) starts the run with your GitHub token; the Cloudflare token stays inside the Actions runner and never touches your laptop.

## Upgrading

Pull the latest code and redeploy. Always use the deploy scripts so migrations and the frontend build run:

```bash
git pull origin main
npm ci
cd central && npm ci && npm run deploy:legiscan

# Repeat for each tenant
cd ../api && npm run deploy:tenant -- org-nj
```

> [!NOTE]
> **Deploy central before the tenants.** Central now runs a migration for the superadmin profile table and adds each superadmin's name and title to the sign-in token. Tenants ignore token fields they don't know, so central first is always safe. A tenant deployed ahead of central keeps working, including emailed-link sign-in, but it doesn't receive superadmin profiles until central is upgraded.

> [!NOTE]
> **Check where your central settings live.** Older versions of `central/wrangler.example.toml` put a few optional settings only in the top-level block, outside `[env.legiscan]`: `DEAD_LETTER_QUEUE`, `EMAIL_FROM`, `ALERT_EMAILS`, `SUPERADMIN_JWT_PUBLIC_KEY`, and the dead-letter `[[queues.consumers]]` entry. Wrangler doesn't carry top-level vars or queue consumers into an environment, so if you filled any of these in at the top level, your central never used them. Job-failure alerts went nowhere, email used the default sender, and superadmin login stayed off. Move them into `[env.legiscan.vars]` and `[[env.legiscan.queues.consumers]]`, then redeploy. Keep the top-level `name` and compatibility settings, which the `legiscan` environment inherits. The rest of the old top-level block (its `main`, D1, R2, queue, cron, and `[vars]` entries) is unused and can be deleted.

## Monitoring

Each tenant Worker exposes `GET /api/health`. On the LegiScan central, the health check is also `GET /api/health` (the bare `/health` path is served by the admin dashboard). The central worker pulls aggregate engagement stats from each tenant once a day, at 06:00 UTC.

## Summary citations

A summary citation takes a reader from a statement in an AI summary to the bill text behind it. (Underneath, each statement is a "claim" and its citation a "claim link", the terms the instance's settings route and central's dashboard use.) When an instance analyzes a bill, it asks the model, in the same call, for a short quote from the bill that supports each claim in the summary. The instance then looks for each quote in the text the reader sees, and records how it matched. On an HTML bill, clicking a statement opens the bill text at that passage, highlighted. On a PDF, it opens the cited page, with the quote shown beside the link. A statement whose quote can't be found is shown as plain text, with no link.

Links arrive with a bill's next analysis. Summaries already written are not backfilled, and a bill with no claim sources reads exactly as it did before.

### The setting

**Summary citations** is a per-instance setting, on by default. An admin can turn it off under **Settings → Config → AI instructions**. With the setting off, new analyses don't ask for claim sources and store none, and existing links show as plain text. Turning it back on shows the stored links again, and new analyses ask again.

### What it costs

Asking for claim sources adds about 490 output tokens to each analysis. That figure comes from the research behind the feature, measured in October 2026. A different model, set with `GEMINI_MODEL`, can differ (see [Choosing the analysis model](/self-hosting/tenants#choosing-the-analysis-model)).

### Relevance scores move slightly

Any change to the analysis call moves relevance scores slightly, and this one does too. In the research behind the feature, the mean score dropped by 0.07 to 0.19 points on the 10-point scale. Of 160 bills, 16 to 17 moved by 2 or more points, against 6 from re-running the same analysis, so a few more bills than usual may cross the digest's relevance threshold when they are next analyzed. Summary quality was unchanged in a blind comparison.

### Reading the counts

Central's dashboard shows, for each instance, how its stored claim sources resolved. Open **Tenants**, choose the instance, and find **Claim links** (the dashboard keeps the earlier name), beside the instance's AI instructions status. Central asks the instance, which scans its bills at most every 30 minutes and reuses the answer in between. The section says how old the counts are, and the cut-off count is always current. When central can't ask, because it has no binding for the instance or the instance hasn't been upgraded to this release, the section says "unavailable" with the reason.

Each claim source is counted once, by how its quote matched:

| Status | What it means |
|---|---|
| **Exact** | Found character for character. |
| **Normalized** | Found after folding spacing, curly quotes, and dashes, and ignoring retained redline markup. |
| **Fuzzy** | Found by a close match (similarity of 0.8 or more), as when line numbers or a running header sit inside the passage. |
| **Anchored** | Only the first or last 32 characters of a long quote matched, so the link lands near the passage but not on all of it. |
| **Ungrounded** | Not found, or the quote was empty. The claim shows as plain text. |
| **Unverified** | A PDF quote. The instance extracts no PDF text, so it can't check the quote, and the link goes by the cited page. This is expected, not a failure. |

Two more signals sit beside the table:

- **Asked, none stored** counts analyses that asked for claim sources and got nothing usable back. Each stored `[]`.
- **Cut off, retried without claim sources** counts analyses whose response ran out of output inside the claim sources. The instance asks once more without them and stores the summary, so the bill is fine but has no links. These retries also leave no list on the bill, so they are counted under **No list stored** along with bills analyzed before summary citations, bills analyzed with the setting off, and bills analyzed on their title and abstract alone. The retry count starts from the release that added it. Each retry also logs `did not parse with claim sources asked; retrying without them`.

For a healthy HTML instance, most quotes resolve as exact, normalized, or fuzzy. The research behind the feature located 91 to 93 percent of quotes in the bill text. A much lower share, with a large ungrounded count, is worth a look. Very long bills resolve fewer quotes, because the instance caps the matching work it spends on one bill. A quote that matches exactly or after normalizing is never affected, so the quotes that go ungrounded first are the ones that would have needed a close match.

The counts are read from the bills, so you can also query them directly:

```bash
npx wrangler d1 execute floorvote-[slug] --remote --env [slug] \
  --command "SELECT json_extract(j.value, '$.status') AS status, COUNT(*) AS n FROM bills b, json_each(b.claim_sources) j WHERE json_valid(b.claim_sources) GROUP BY status"

# Responses cut off inside claim sources and retried without them
npx wrangler d1 execute floorvote-[slug] --remote --env [slug] \
  --command "SELECT value FROM association_config WHERE key = 'claim_sources_cutoff_retries'"
```

Counts cover only bills analyzed since the instance began asking for claim sources, so they grow as bills are analyzed again.
