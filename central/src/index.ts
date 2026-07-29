import { Hono } from 'hono'
import { WorkerEntrypoint } from 'cloudflare:workers'
import { drizzle } from 'drizzle-orm/d1'
import * as schema from './db/schema'
import { runSync } from './cron/sync'
import { runKeywordSweep } from './cron/keywordSweep'
import { processIngestorQueue } from './queue/processor'
import { getProvider } from './providers/index'
import { tenantsRoutes } from './routes/tenants'
import { billsRoutes } from './routes/bills'
import { statsRoutes } from './routes/stats'
import { healthRoutes } from './routes/health'
import { adminRoutes } from './routes/admin'
import { runJob } from './lib/jobAlert'
import { errorHandler } from './lib/errorHandler'
import { checkEmailSuppression } from './lib/emailSuppression'
import { getEmailDeliveryStatus } from './lib/emailDelivery'
import type { Env } from './types'

export const app = new Hono<{ Bindings: Env }>()

// Safety net for uncaught errors: structured 500, no detail leak (HTTPExceptions
// pass through). Route-level error responses still win.
app.onError(errorHandler)

// Machine API under /api/* — the canonical prefix tenants call (centralFetch
// prepends /api). Kept in parity with the legiscan central. The bare-path mounts
// below are retained for backward compatibility (no SPA collision on this env).
app.route('/api/tenants', tenantsRoutes)
app.route('/api/bills', billsRoutes)
app.route('/api/tenants', statsRoutes)
app.route('/api/health', healthRoutes)
app.route('/api/admin', adminRoutes)

app.route('/tenants', tenantsRoutes)
app.route('/bills', billsRoutes)
app.route('/tenants', statsRoutes)
app.route('/health', healthRoutes)
app.route('/admin', adminRoutes)

export default {
  fetch: app.fetch,

  async queue(batch: MessageBatch, env: Env): Promise<void> {
    const db = drizzle(env.DB, { schema })
    await processIngestorQueue(batch as MessageBatch<import('./types').IngestorQueueMessage>, env, db)
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    const db = drizzle(env.DB, { schema })
    const provider = getProvider(env, db)

    ctx.waitUntil(runJob(env, 'sync', () => runSync(env, db, provider)))

    if (event.cron === '0 6 * * *') {
      ctx.waitUntil(runJob(env, 'keyword-sweep', () => runKeywordSweep(env, db, provider)))
    }
  },
}

/**
 * Named entrypoint reachable ONLY via same-account service bindings.
 *
 * NOTE: unlike the LegiScan env's TenantApi (central/src/index-legiscan.ts),
 * this OpenStates entrypoint does NOT apply the tenant-surface allowlist
 * (lib/tenantSurface) or the per-binding object-level authz (ctx.props.tenantId
 * → x-caller-tenant guard in lib/callerTenant). It injects the admin secret and
 * forwards every route, so any bound tenant can reach central's full surface —
 * including other tenants' objects — with central's privileges. OpenStates is
 * the experimental provider and not at feature parity; port the LegiScan
 * entrypoint's allowlist + caller-tenant guard here before relying on this in a
 * multi-tenant deployment.
 */
export class TenantApi extends WorkerEntrypoint<Env> {
  fetch(req: Request): Response | Promise<Response> {
    const headers = new Headers(req.headers)
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
