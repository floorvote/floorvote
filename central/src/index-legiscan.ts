import { Hono } from 'hono'
import { WorkerEntrypoint } from 'cloudflare:workers'
import { drizzle } from 'drizzle-orm/d1'
import * as schema from './db/schema-legiscan'
import { runLsSync } from './cron/sync-legiscan'
import { pullEngagementStats, shouldRunEngagementPull } from './cron/engagement-pull'
import { processLsIngestorQueue } from './queue/processor-legiscan'
import { billsLsRoutes } from './routes/bills-legiscan'
import { tenantsLsRoutes } from './routes/tenants-legiscan'
import { adminLsRoutes } from './routes/admin-legiscan'
import { healthRoutes } from './routes/health'
import { dashAuthRoutes } from './routes/dash-auth'
import { dashRoutes } from './routes/dash'
import { dashEngagementRoutes } from './routes/dash-engagement'
import { dashUnknownLoginsRoutes } from './routes/dash-unknown-logins'
import { runJob } from './lib/jobAlert'
import { runAnomalyWatch } from './lib/anomalyWatch'
import { pruneRevokedSuperadminJtis } from './lib/superadminRevocation'
import type { LsEnv, LsIngestorMessage } from './types-legiscan'
import { errorHandler } from './lib/errorHandler'
import { checkEmailSuppression } from './lib/emailSuppression'
import { getEmailDeliveryStatus } from './lib/emailDelivery'
import { isTenantSurfaceAllowed } from './lib/tenantSurface'
import { CALLER_TENANT_HEADER } from './lib/callerTenant'
import { setSecurityHeaders } from '../../shared/securityHeaders'

export const app = new Hono<{ Bindings: LsEnv }>()

// Safety net for uncaught errors: structured 500, no detail leak (HTTPExceptions
// pass through). Route-level error responses still win.
app.onError(errorHandler)

// Security response headers (CSP report-only, X-Frame-Options, nosniff). Set
// BEFORE next() so they merge onto the final response, including immutable
// Workers-Assets responses. See shared/securityHeaders.ts.
app.use('*', async (c, next) => {
  setSecurityHeaders(c.res.headers)
  await next()
})

// Dashboard SPA API (cookie-authenticated, served to the browser).
app.route('/admin/dash/auth', dashAuthRoutes)
app.route('/admin/dash/engagement', dashEngagementRoutes)
app.route('/admin/dash/unknown-logins', dashUnknownLoginsRoutes)
app.route('/admin/dash', dashRoutes)

// Machine API under /api/* — the canonical prefix. Kept off the bare paths so it
// no longer shadows the dashboard SPA's client routes (/tenants, /adoption, …),
// which made hard-refresh / deep-link to those pages return raw API JSON. All
// callers (tenant centralFetch, operator tooling) target /api/*; bare /tenants,
// /bills, /admin now fall through to the SPA catch-all below.
app.route('/api/tenants', tenantsLsRoutes)
app.route('/api/bills', billsLsRoutes)
app.route('/api/admin', adminLsRoutes)
app.route('/api/health', healthRoutes)

app.get('*', (c) => {
  const assets = c.env.ASSETS as Fetcher | undefined
  return assets ? assets.fetch(c.req.raw) : c.notFound()
})

export default {
  fetch: app.fetch,

  async queue(batch: MessageBatch, env: LsEnv): Promise<void> {
    const db = drizzle(env.DB, { schema })
    await processLsIngestorQueue(
      batch as MessageBatch<LsIngestorMessage>,
      env,
      db,
    )
  },

  async scheduled(_event: ScheduledEvent, env: LsEnv, ctx: ExecutionContext): Promise<void> {
    const db = drizzle(env.DB, { schema })
    ctx.waitUntil(runJob(env, 'ls-sync', () => runLsSync(env, db)))
    if (shouldRunEngagementPull(new Date())) {
      ctx.waitUntil(runJob(env, 'engagement-pull', () => pullEngagementStats(env, db)))
      ctx.waitUntil(runJob(env, 'd1-anomaly-watch', () => runAnomalyWatch(env)))
      ctx.waitUntil(runJob(env, 'prune-revoked-jtis', () => pruneRevokedSuperadminJtis(db)))
    }
  },
}

/**
 * Named entrypoint reachable ONLY via same-account service bindings (never the
 * public internet). Tenant workers bind to this with `entrypoint = "TenantApi"`.
 * Arrival here IS the authentication: we inject the shared admin secret
 * server-side and forward to the Hono app, so tenants no longer carry the secret.
 *
 * Because service bindings carry no caller identity, every route reachable here
 * is reachable by every tenant. So this entrypoint is DENY-BY-DEFAULT: only the
 * explicit `(method, path)` operations on the tenant allowlist
 * (`./lib/tenantSurface`) are forwarded; anything else returns 403 BEFORE the
 * admin secret is injected. Operator-only routes (reingest-tenant, anomaly-watch,
 * the cross-tenant operator fan-out, superadmin mint, …) are intentionally NOT
 * on the allowlist — they remain reachable only over central's public HTTP
 * `/api/*` gated by `x-admin-secret` (operator CLI/dashboard).
 *
 * OBJECT-LEVEL AUTHZ: the allowlist bounds WHICH operations, not WHICH tenant's
 * objects — the allowlisted routes take `:tenantId`/`body.tenantId`. We identify
 * the CALLING tenant from `ctx.props.tenantId` — a per-binding prop set at deploy
 * time that Cloudflare guarantees is authentic/unforgeable — and surface it as
 * the `x-caller-tenant` header so the route guards (`./lib/callerTenant`) can
 * reject cross-tenant access. Any client-supplied `x-caller-tenant` is stripped
 * first so a tenant cannot assert another's identity; a tenant without the prop
 * yet (rollout window) simply carries no header and is treated leniently.
 */
export class TenantApi extends WorkerEntrypoint<LsEnv, { tenantId?: string }> {
  fetch(req: Request): Response | Promise<Response> {
    const { pathname } = new URL(req.url)
    if (!isTenantSurfaceAllowed(req.method, pathname)) {
      return new Response(JSON.stringify({ error: 'forbidden' }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      })
    }
    const headers = new Headers(req.headers)
    // Strip any client-supplied caller id (anti-spoof), then set it from the
    // unforgeable per-binding prop. A tenant not yet redeployed with the prop
    // carries no header → the route guards treat it leniently (see callerTenant).
    headers.delete(CALLER_TENANT_HEADER)
    const callerTenant = this.ctx.props?.tenantId
    if (callerTenant) headers.set(CALLER_TENANT_HEADER, callerTenant)
    headers.set('x-admin-secret', this.env.ADMIN_SECRET)
    return app.fetch(new Request(req, { headers }), this.env, this.ctx)
  }

  async emailSuppression(email: string): Promise<{ suppressed: boolean | null; reason?: string; createdAt?: string }> {
    return checkEmailSuppression(this.env, email)
  }

  async emailDeliveryStatus(messageIds: string[], since: string): Promise<Record<string, { status: string; isSpam: boolean; errorCause?: string; datetime?: string }>> {
    return getEmailDeliveryStatus(this.env, { messageIds, since })
  }
}
