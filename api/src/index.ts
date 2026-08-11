import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { getCookie } from 'hono/cookie'
import { bodyLimit } from 'hono/body-limit'
import { authRoutes } from './routes/auth'
import { billsApiRouter } from './routes/billsApi'
import { commentsApiRouter } from './routes/commentsApi'
import { feedRouter } from './routes/feed'
import { usersRouter, rolesRouter } from './routes/users'
import { statsRouter } from './routes/stats'
import { feedbackRouter } from './routes/feedback'
import { adminApiRouter } from './routes/adminApi'
import { notificationsRouter } from './routes/notificationsApi'
import { configRouter } from './routes/configApi'
import { calendarRouter } from './routes/calendarApi'
import { registerWithCentral } from './cron/sync'
import { runDemoReset } from './lib/demoReset'
import { resolveDemoSeed } from './lib/demoSeeds'
import { runDigest } from './lib/digest'
import { runWeekAhead } from './lib/weekAhead'
import { sendSampleEmail, isSampleEmailType } from './lib/sampleEmails'
import { hashToken, secretsMatch } from './lib/crypto'
import { isAllowedOrigin } from './lib/cors'
import { parseAppDomains } from './lib/appDomains'
import { errorHandler } from './lib/errorHandler'
import { setSecurityHeaders } from '../../shared/securityHeaders'
import { centralFetch } from './lib/centralFetch'
import { processQueue } from './queue/processor'
import { processInviteEmails } from './queue/inviteEmails'
import { getDb } from './db/client'
import { computeEngagementSnapshot } from './lib/engagementSnapshot'
import { refreshMetadata } from './lib/refreshMetadata'
import { demoResetAndSeed } from './lib/demoResetAndSeed'
import { runJob } from './lib/jobAlert'
import { nowDb } from './lib/dbTime'
import { ensureDemoSession, DEMO_SESSION_TOKEN } from './lib/demoSession'
import { demoReadOnly } from './middleware/auth'
import type { Env, AppEnv, QueueMessage, InviteEmailMessage, TenantQueueMessage } from './types'

const app = new Hono<AppEnv>()

// Safety net for uncaught errors: structured 500, no detail leak (HTTPExceptions
// pass through). Route-level try/catch and explicit error responses still win.
app.onError(errorHandler)

app.use('*', async (c, next) => {
  c.res.headers.set('X-Robots-Tag', 'noindex, nofollow')
  await next()
})

// Security response headers (CSP enforcing, X-Frame-Options, nosniff). Set
// BEFORE next() so they merge onto the final response, including immutable
// Workers-Assets responses. See shared/securityHeaders.ts.
app.use('*', async (c, next) => {
  setSecurityHeaders(c.res.headers)
  await next()
})

app.use('*', async (c, next) => {
  const appDomains = parseAppDomains(c.env.APP_DOMAINS)
  return cors({
    origin: (origin) => (isAllowedOrigin(origin, c.env.APP_URL, appDomains) ? origin : null),
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type'],
    credentials: true,
  })(c, next)
})

// Demo auto-login — when DEMO_MODE=true, visitors without a valid session are logged in as demo-user.
// Injects Set-Cookie directly into the HTML response (no redirect round-trip).
// The /login path is excluded so the login form remains accessible at demo.example.com/login.
app.use('*', async (c, next) => {
  if (c.env.DEMO_MODE !== 'true') return await next()
  const path = new URL(c.req.url).pathname
  if (path.startsWith('/api/') || path === '/login') return await next()

  // Finding D1: reuse ONE shared demo session instead of minting a fresh
  // `sessions` row per request (bot traffic to no-store demo HTML previously
  // accumulated one row per hit). Only fall back to the shared session when
  // there's no valid existing session, so a real admin/superadmin session on
  // the demo isn't clobbered.
  let setDemoCookie = false
  const existingCookie = getCookie(c, 'session')
  let valid = false
  if (existingCookie) {
    const existingHash = await hashToken(existingCookie)
    // expires_at may be space format (UTC); compare via datetime() so the raw
    // string compare (" " < "T") can't mis-order a future expiry below now.
    valid = !!(await c.env.DB.prepare(
      "SELECT 1 FROM sessions WHERE token_hash = ? AND datetime(expires_at) > datetime(?) LIMIT 1"
    ).bind(existingHash, nowDb()).first())
  }
  if (!valid) {
    await ensureDemoSession(c.env.DB)
    setDemoCookie = true
  }

  await next()

  // Only modify HTML responses (not JS/CSS/font assets which can stay cached)
  const contentType = c.res.headers.get('content-type') ?? ''
  if (!contentType.includes('text/html')) return

  const h = new Headers(c.res.headers)
  // Disable CDN caching for demo HTML — Cloudflare caches index.html by default,
  // which means the Worker never runs for cached requests and auto-login is skipped.
  h.set('Cache-Control', 'no-store, no-cache')
  if (setDemoCookie) {
    const expires = new Date('9999-12-31T23:59:59Z').toUTCString()
    h.append('Set-Cookie', `session=${DEMO_SESSION_TOKEN}; HttpOnly; Secure; SameSite=Lax; Path=/; Expires=${expires}`)
  }
  c.res = new Response(c.res.body, { status: c.res.status, statusText: c.res.statusText, headers: h })
})

// Demo tenants allow the additive member actions and refuse every other non-GET
// request (see DEMO_WRITE_ALLOWLIST in middleware/auth.ts). Mounted before every
// /api route so a write route added later is locked by default rather than by
// remembering to guard it.
app.use('/api/*', demoReadOnly)

// Cap the body on the public, unauthenticated auth endpoints. Their
// JSON payloads are tiny ({ email, turnstileToken }); 16 KB is generous. Fronts
// the routes so an oversized POST is rejected (413) before any handler work.
app.use('/api/auth/*', bodyLimit({ maxSize: 16 * 1024 }))
app.route('/api/auth', authRoutes)
app.route('/api/bills', billsApiRouter)
app.route('/api/comments', commentsApiRouter)
app.route('/api/admin', adminApiRouter)
app.route('/api/config', configRouter)
app.route('/api/feed', feedRouter)
app.route('/api/users', usersRouter)
app.route('/api/roles', rolesRouter)
app.route('/api/stats', statsRouter)
app.route('/api/feedback', feedbackRouter)
app.route('/api/notifications', notificationsRouter)
app.route('/api/calendar', calendarRouter)

app.get('/api/health', (c) => c.json({ ok: true, build: BUILD_SHA }))

// Returns true when the request should be rejected: secret unset (prod lockdown)
// or header mismatch (wrong caller). In local dev CENTRAL_ADMIN_SECRET is set in
// .dev.vars so the check still applies; callers just pass the same value.
// Uses a timing-safe compare (matches central's route guards) so the header
// can't be probed byte-by-byte.
async function internalAuthFail(c: { req: { header(n: string): string | undefined }; env: Env }): Promise<boolean> {
  if (!c.env.CENTRAL_ADMIN_SECRET) return true
  return !(await secretsMatch(c.req.header('x-admin-secret'), c.env.CENTRAL_ADMIN_SECRET))
}

app.post('/api/internal/force-register', async (c) => {
  if (await internalAuthFail(c)) return c.json({ error: 'unauthorized' }, 401)
  try {
    const db = getDb(c.env.DB)
    const ok = await registerWithCentral(c.env, db)
    return c.json({ ok })
  } catch (err: any) {
    return c.json({ ok: false, error: err.message }, 500)
  }
})

app.post('/api/internal/demo-reset', async (c) => {
  if (c.env.DEMO_MODE !== 'true') return c.json({ error: 'Not found' }, 404)
  if (await internalAuthFail(c)) return c.json({ error: 'unauthorized' }, 401)
  const r = await demoResetAndSeed(c.env)
  return c.json({ ok: r.ok, message: 'Demo data reset complete', billsSeeded: r.billsSeeded })
})

app.post('/api/internal/run-digest', async (c) => {
  if (await internalAuthFail(c)) return c.json({ error: 'unauthorized' }, 401)
  const db = getDb(c.env.DB)
  const result = await runDigest(c.env, db, { ignoreSchedule: true })
  return c.json(result)
})

// Send one sample email (rendered from fixed data) to a single address — a QA
// tool for the email templates that bypasses recipient lists and schedules.
// Sends ONLY to the given `to`, via the real send path.
app.post('/api/internal/send-sample-email', async (c) => {
  if (await internalAuthFail(c)) return c.json({ error: 'unauthorized' }, 401)
  const body = await c.req.json<{ to?: string; type?: string }>().catch(() => ({} as { to?: string; type?: string }))
  if (!body.to || !body.type) return c.json({ error: 'to and type are required' }, 400)
  if (!isSampleEmailType(body.type)) {
    return c.json({ error: 'type must be one of: login, invite, week-ahead, digest' }, 400)
  }
  const result = await sendSampleEmail(c.env, getDb(c.env.DB), body.to, body.type)
  return c.json({ ok: result.ok, type: body.type, to: body.to, provider: result.provider, error: result.error }, result.ok ? 200 : 502)
})

app.post('/api/internal/refresh-metadata', async (c) => {
  if (await internalAuthFail(c)) return c.json({ error: 'unauthorized' }, 401)
  if (!c.env.BILL_QUEUE) return c.json({ error: 'Queue not configured' }, 503)
  return c.json(await refreshMetadata(c.env, getDb(c.env.DB)))
})

app.post('/api/internal/register', async (c) => {
  if (await internalAuthFail(c)) return c.json({ error: 'unauthorized' }, 401)
  try {
    const db = getDb(c.env.DB)
    const res = await centralFetch(c.env, '/tenants/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tenantId: c.env.TENANT_ID,
        name: c.env.ASSOCIATION_NAME ?? c.env.TENANT_ID,
        stateCoverage: [c.env.STATE ?? '*'],
        keywords: [],
      }),
    })
    const result = await res.json()
    return c.json({ ok: res.ok, status: res.status, central: result })
  } catch (err: any) {
    return c.json({ ok: false, error: err.message }, 500)
  }
})

app.get('/api/internal/engagement-stats', async (c) => {
  if (await internalAuthFail(c)) return c.json({ error: 'unauthorized' }, 401)
  const raw = c.req.query('excludeDomains')
  const excludeDomains = raw ? raw.split(',').map(s => s.trim()).filter(Boolean) : undefined
  const snap = await computeEngagementSnapshot(getDb(c.env.DB), excludeDomains)
  return c.json({ data: snap, meta: { generatedAt: snap.computedAt } })
})

app.get('*', (c) => {
  if (!c.env.ASSETS) {
    return c.json({ error: 'not found' }, 404)
  }
  return c.env.ASSETS.fetch(c.req.raw)
})

export { app }
export { CentralApi } from './centralApi'

export default {
  fetch: app.fetch,

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    const db = getDb(env.DB)
    if (env.DEMO_MODE === 'true') {
      ctx.waitUntil(runJob(env, 'demo-reset', () => runDemoReset(env.DB, resolveDemoSeed(env.DEMO_SEED))))   // demo: 06:00 reset only; no digests
      return
    }
    if (event.cron === '0 11 * * *') {
      // Sequential: both jobs upsert association_config; concurrent writes cause D1 SQLITE_BUSY
      ctx.waitUntil(
        runJob(env, 'digest', () => runDigest(env, db))
          .then(() => runJob(env, 'week-ahead', () => runWeekAhead(env, db)))
      )
      return
    }
    ctx.waitUntil(runJob(env, 'register', () => registerWithCentral(env, db)))
  },

  async queue(batch: MessageBatch<QueueMessage>, env: Env) {
    const isInvite = (m: Message<QueueMessage>): m is Message<InviteEmailMessage> =>
      (m.body as { type?: string }).type === 'invite-email'

    // In demo mode, freeze the bill set — except allow explicit reseeds
    // (forceMetadata), metadata-only refreshes (metadataOnly), and admin-triggered
    // AI re-runs (forceAI). Invite jobs carry none of these, so a pure invite batch
    // is dropped (auto-acked) here — demo never emails.
    if (env.DEMO_MODE === 'true' && !batch.messages.some(m => {
      const b = m.body as { forceMetadata?: boolean; metadataOnly?: boolean; forceAI?: boolean }
      return b.forceMetadata || b.metadataOnly || b.forceAI
    })) return

    const db = getDb(env.DB)
    const invites = batch.messages.filter(isInvite)
    const bills = batch.messages.filter((m): m is Message<TenantQueueMessage> => !isInvite(m))

    if (invites.length > 0) await processInviteEmails(invites, env, db)
    if (bills.length > 0) await processQueue(bills, env, db)
  },
}
