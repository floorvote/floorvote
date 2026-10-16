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

## Verifying an instance after provisioning

`scripts/verify-instance.sh <slug>` (run last by `new-instance.sh`, and by hand any time) smoke-tests an instance. Its logic is `scripts/lib/verify-instance.ts` with fetch, time, and the filesystem injected, which is what `verify-instance.test.ts` exercises; `scripts/lib/new-instance.verify.test.ts` runs the real `new-instance.sh` against a faked wrangler and a local fake central.

Past the health check, which hits the instance directly, every check goes through central's admin-secret operator routes in `central/src/routes/tenants.ts`, because a tenant holds no secret of its own:

| Route | Used by | What it does |
|---|---|---|
| `GET /api/tenants/:id/registration` | Registration | Registered, active, states, keyword count, whether central is bound (`CentralApi`), and how it would deliver (`binding`, `queue`, or `none`). |
| `POST /api/tenants/:id/verify-delivery` `{ nonce }` | Queue delivery | Picks one stored bill and sends the instance `{ tenantId, billId, probe: nonce }` down its real delivery path. |
| `GET /api/tenants/:id/delivery-probe` | Queue delivery | Asks the instance (`CentralApi.deliveryProbe`) which probe it last received. |
| `POST /api/tenants/:id/verify-ai` | AI analysis | Asks the instance (`CentralApi.verifyAi`) to analyze one stored bill; returns the result and writes nothing. |
| `POST /api/tenants/:id/send-sample-email` | Email | Existing route; the check sends the `digest` sample to the operator only. |

None is on `TenantApi`'s allowlist, so no tenant can call them, and none calls LegiScan: the bill is always one central already stores (`pickVerificationBill`: newest with text in the tenant's states, else any in its states, else any).

An instance from before the probe existed would treat it as an ordinary bill notification (tracking the bill, spending AI, posting a feed event), so `verify-delivery` first calls the instance's `deliveryProbe()` over the binding and answers 409 `{ predates: true }` without sending if that throws. The script maps that, a plain-text 404 from an older central, and an RPC "method not implemented" error to "predates verify-instance; redeploy". The queue handler in `api/src/index.ts` processes probes on their own before the demo freeze, so a probe neither drops on a demo nor unfreezes the ordinary messages sharing its batch. `pickVerificationBill` queries one state at a time with an early-exit `EXISTS`, to keep D1 rows read small.

A `probe` message is handled before any bill logic (`api/src/lib/deliveryProbe.ts`): the consumer reads the bill back from central to prove the `CENTRAL` binding, records `{ nonce, billId, receivedAt, readStatus }` under the `delivery_probe` key in `association_config`, and acknowledges. It writes no bill row and no feed event, so verifying never changes which bills the instance tracks. The AI check shares its prompt inputs with the queue consumer (`api/src/lib/analysisInputs.ts`) so it exercises what the pipeline would.

Failures carry a `stage` (`deploy`, `secrets`, `bind`, `register`, or `verify`). `new-instance.sh` passes the step number of each (`step <key> "..."` records `STEP_NO_<key>`) so the resume line names the earliest step that needs re-running, and passes the commit step 4 deployed as the expected build, because the commits after the deploy move HEAD.
