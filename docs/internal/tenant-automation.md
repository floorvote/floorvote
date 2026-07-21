# What can and can't be scripted when adding a tenant

> Moved out of the public tenant guide. Useful orientation for a coding agent (or anyone) automating tenant standup: which pieces `wrangler` can create versus which are dashboard-only, one-time, and reused by every tenant.

Almost everything per-tenant is scriptable with `wrangler`: creating the D1 database, the queue, running migrations, and deploying. The Cloudflare **credentials** are not — and they don't need to be, because they are **account-level and created once, then reused by every tenant**:

| Credential | Scriptable? | How it's obtained |
|---|---|---|
| `CF_ACCOUNT_ID` | Read-only | `wrangler whoami`, or the dashboard. Same value for every tenant. |
| `CLOUDFLARE_API_TOKEN` (deploy) | **No** — dashboard only | Dashboard → My Profile → API Tokens. One token deploys every tenant. |
| AI Gateway (`CF_AIG_GATEWAY`) | **No** — dashboard only | `wrangler` has no AI Gateway command. Create once; all tenants share it. |
| `CF_AIG_TOKEN` (gateway auth) | **No** — dashboard only | Generated inside the gateway's Settings; account-scoped, so one token serves every tenant. |
| `SUPERADMIN_JWT_PUBLIC_KEY` | n/a (committed var) | The ES256 public JWK, identical on every env — copy from any existing `[env.*]` block. |

So the per-tenant "secret setting" work is small: only `CF_AIG_TOKEN` is strictly required, and you paste the same value you used for the last tenant.
