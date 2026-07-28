import { Hono } from 'hono'
import { drizzle } from 'drizzle-orm/d1'
import { eq, and, isNull, isNotNull, inArray } from 'drizzle-orm'
import * as schema from '../db/schema-legiscan'
import { bills, billTenants, tenants, keywordRegistry, sessions, apiCallLog } from '../db/schema-legiscan'
import { matchesUnion } from '../lib/keywords'
import { getMasterListBySession } from '../lib/legiscan'
import { secretsMatch } from '../lib/auth'
import { isSuperadminEmail } from '../lib/superadminIssuer'
import { revokeSuperadminJti } from '../lib/superadminRevocation'
import { SUPERADMIN_TOKEN_TTL_SEC } from '../lib/superadminJwt'
import { runLsSync } from '../cron/sync-legiscan'
import { runAnomalyWatch } from '../lib/anomalyWatch'
import { nowDb } from '../lib/dbTime'
import type { LsEnv, LsIngestorMessage, LsNotificationMessage } from '../types-legiscan'
import { getTenantQueue } from '../lib/tenantQueue'
import { deliverBatchToTenant } from '../lib/tenantDelivery'
import { queuesRestEnabled } from '../lib/queuesRest'
import { guardCallerTenantParam } from '../lib/callerTenant'

// Per-tenant cooldown for sync-keywords. Module-scoped Map is intentional —
// Worker instances are isolated, so this is effectively a per-instance cooldown.
// Good enough to prevent accidental hammering from a single admin clicking
// "Sync bill tracker" repeatedly; not a hard distributed guarantee.
const SYNC_KEYWORDS_COOLDOWN_MS = 60_000
const SYNC_KEYWORDS_CAP = 1000
const lastSyncKeywordsAt = new Map<string, number>()

export const adminLsRoutes = new Hono<{ Bindings: LsEnv }>()

adminLsRoutes.use('*', async (c, next) => {
  if (!(await secretsMatch(c.req.header('x-admin-secret'), c.env.ADMIN_SECRET))) {
    return c.json({ error: 'unauthorized' }, 401)
  }
  await next()
})

adminLsRoutes.post('/trigger-sync', async (c) => {
  const db = drizzle(c.env.DB, { schema })
  await runLsSync(c.env, db)
  return c.json({ ok: true, message: 'sync triggered' })
})

// Superadmin email check (login-request path). Central is the SOLE issuer of the
// cross-tenant `superadmin_jwt` cookie and mints it INTERNALLY on dashboard
// magic-link verify (see `routes/dash-auth.ts`). There is deliberately NO mint
// route reachable by tenants: a tenant calling a mint endpoint could forge a
// superadmin session for any allowlisted email without a real login (finding H2).
// Tenants only ask whether an email is a superadmin so they can auto-provision a
// local admin when that person magic-links into the tenant directly.
adminLsRoutes.get('/superadmin/check', (c) => {
  const email = c.req.query('email') ?? ''
  return c.json({ isSuperadmin: isSuperadminEmail(c.env, email) })
})

// SHA-256 hashes of the superadmin allowlist so a tenant can cache them and test
// membership LOCALLY (finding D3) instead of an RPC to `check` per magic-link
// request — a flood of random unknown emails otherwise amplifies into one
// central call each. Hashes (not plaintext) so a compromised tenant gains no
// more than the existing per-email `check` oracle: it can confirm a *guessed*
// address but isn't handed a clean reversible list.
adminLsRoutes.get('/superadmin/emails', async (c) => {
  const emails = (c.env.SUPERADMIN_EMAILS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
  const hashes = await Promise.all(emails.map(sha256Hex))
  return c.json({ hashes })
})

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

// Decode a JWT payload WITHOUT verifying its signature — used only to extract
// `jti`/`exp` from an operator-supplied token for revocation. The operator is
// already authenticated by `x-admin-secret`; worst case they revoke a jti that
// was never issued, which is harmless.
function decodeJwtPayload(token: string): { jti?: unknown; exp?: unknown } | null {
  const seg = token.split('.')[1]
  if (!seg) return null
  try {
    const p = seg.replace(/-/g, '+').replace(/_/g, '/')
    return JSON.parse(atob(p + '==='.slice((p.length + 3) % 4)))
  } catch {
    return null
  }
}

// Operator-only (NOT on the tenant surface allowlist): revoke a single superadmin
// SSO token by its `jti` (finding M3). Accepts `{ jti }` directly or `{ token }`
// (the leaked cookie value) which we decode for its jti/exp. `exp` (epoch seconds)
// is stored so the revocation row self-prunes once the token would expire anyway;
// it defaults to now + the max token TTL. Takes effect immediately on central;
// tenants honor it only within the token's remaining TTL (they have no link to
// this store). See docs/superadmin-revocation.md (Case A0).
adminLsRoutes.post('/superadmin/revoke', async (c) => {
  const body = await c.req.json<{ jti?: string; token?: string; exp?: number }>().catch(() => ({} as { jti?: string; token?: string; exp?: number }))
  let jti = typeof body.jti === 'string' ? body.jti.trim() : ''
  let exp = typeof body.exp === 'number' && Number.isFinite(body.exp) ? Math.floor(body.exp) : 0
  if (!jti && typeof body.token === 'string') {
    const decoded = decodeJwtPayload(body.token)
    if (decoded && typeof decoded.jti === 'string') jti = decoded.jti.trim()
    if (!exp && decoded && typeof decoded.exp === 'number' && Number.isFinite(decoded.exp)) exp = Math.floor(decoded.exp)
  }
  if (!jti) return c.json({ error: 'jti or token required' }, 400)
  // Any missing / non-future exp falls back to the conservative now + max-TTL, so
  // a bogus past/negative exp can't make the revocation row self-prune (and thus
  // un-revoke) before the token would actually expire.
  const nowSec = Math.floor(Date.now() / 1000)
  if (!exp || exp <= nowSec) exp = nowSec + SUPERADMIN_TOKEN_TTL_SEC
  const db = drizzle(c.env.DB, { schema })
  await revokeSuperadminJti(db, jti, exp)
  return c.json({ ok: true, jti, exp })
})

// Manual trigger / dry-run for the D1 read-spike anomaly watch. The cron runs it
// once daily at 06:00 UTC with no HTTP trigger; this lets an operator confirm the
// CF-analytics query returns real per-DB numbers, check D1 read health on demand,
// and verify the alert logic both ways. Dry-run by default (no email):
//   ?factor=N&floor=N  override the thresholds (e.g. factor=1&floor=0 to confirm a
//                       lowered threshold WOULD fire on otherwise-normal traffic)
//   ?send=1            actually send the ops-alert email when something is flagged
adminLsRoutes.post('/anomaly-watch', async (c) => {
  const factorRaw = c.req.query('factor')
  const floorRaw = c.req.query('floor')
  const factor = factorRaw !== undefined && factorRaw !== '' ? Number(factorRaw) : undefined
  const floor = floorRaw !== undefined && floorRaw !== '' ? Number(floorRaw) : undefined
  if ((factor !== undefined && !Number.isFinite(factor)) || (floor !== undefined && !Number.isFinite(floor))) {
    return c.json({ error: 'factor and floor must be numbers' }, 400)
  }
  const send = c.req.query('send') === '1'
  const result = await runAnomalyWatch(c.env, { factor, floor, send })
  return c.json(result)
})

adminLsRoutes.post('/backfill-match-types', async (c) => {
  const db = drizzle(c.env.DB, { schema })
  const allTenants = await db.select({ tenantId: tenants.tenantId }).from(tenants).all()

  const results: { tenantId: string; matched: number; checked: number }[] = []
  const FLUSH_BATCH = 500

  for (const t of allTenants) {
    const kwRows = await db.select({ keyword: keywordRegistry.keyword })
      .from(keywordRegistry)
      .where(eq(keywordRegistry.tenantId, t.tenantId))
      .all()
    const keywords = kwRows.map(r => r.keyword.toLowerCase())

    if (keywords.length === 0) {
      results.push({ tenantId: t.tenantId, matched: 0, checked: 0 })
      continue
    }

    const unlinkedRows = await db.select({
      billId: billTenants.billId,
      title: bills.title,
      description: bills.description,
      billNumber: bills.billNumber,
    })
      .from(billTenants)
      .innerJoin(bills, eq(billTenants.billId, bills.billId))
      .where(and(
        eq(billTenants.tenantId, t.tenantId),
        isNull(billTenants.matchType),
      ))
      .all()

    const matchedIds: number[] = []
    for (const r of unlinkedRows) {
      const haystack = `${r.title ?? ''} ${r.description ?? ''} ${r.billNumber ?? ''}`
      if (matchesUnion(haystack, keywords).matched) {
        matchedIds.push(r.billId)
      }
    }

    // Promote matched rows in batches
    const updateStmts = matchedIds.map(billId =>
      db.update(billTenants)
        .set({ matchType: 'keyword' })
        .where(and(
          eq(billTenants.billId, billId),
          eq(billTenants.tenantId, t.tenantId),
          isNull(billTenants.matchType),  // guard: never overwrite manual or already-keyword
        ))
    )

    for (let i = 0; i < updateStmts.length; i += FLUSH_BATCH) {
      const chunk = updateStmts.slice(i, i + FLUSH_BATCH) as [any, ...any[]]
      if (chunk.length > 0) await db.batch(chunk)
    }

    results.push({ tenantId: t.tenantId, matched: matchedIds.length, checked: unlinkedRows.length })
  }

  return c.json({ ok: true, results })
})

// POST /admin/sync-keywords/:tenantId — re-evaluate a tenant's current keywords
// against bills already linked to that tenant (match_type IS NULL only — already-matched
// bills and manually-added bills are untouched). For each newly-matching bill, promote
// match_type='keyword' and queue through the ingestor with forceAI:true so it gets
// text fetched and full-text AI run on the tenant side.
//
// Rate-limited per tenant (60s cooldown) and capped at 1000 newly-matched bills per call.
adminLsRoutes.post('/sync-keywords/:tenantId', guardCallerTenantParam(), async (c) => {
  const tenantId = c.req.param('tenantId')
  const db = drizzle(c.env.DB, { schema })

  const tenant = await db.select().from(tenants).where(eq(tenants.tenantId, tenantId)).get()
  if (!tenant) return c.json({ error: 'tenant not found' }, 404)

  // Rate limit
  const now = Date.now()
  const lastRun = lastSyncKeywordsAt.get(tenantId)
  if (lastRun && now - lastRun < SYNC_KEYWORDS_COOLDOWN_MS) {
    const retryInSec = Math.ceil((SYNC_KEYWORDS_COOLDOWN_MS - (now - lastRun)) / 1000)
    return c.json({ error: `rate limited; retry in ${retryInSec}s` }, 429)
  }
  lastSyncKeywordsAt.set(tenantId, now)

  // Load tenant keywords from central's keyword_registry
  const kwRows = await db.select({ keyword: keywordRegistry.keyword })
    .from(keywordRegistry)
    .where(eq(keywordRegistry.tenantId, tenantId))
    .all()
  const keywords = kwRows.map(r => r.keyword.toLowerCase())
  if (keywords.length === 0) {
    return c.json({ ok: true, newlyMatched: 0, candidates: 0, truncated: false, note: 'no keywords configured' })
  }

  // Find unmatched bill_tenants rows joined with bills metadata.
  // Only consider bills currently match_type=null — already-matched bills are untouched.
  const candidates = await db.select({
    billId: billTenants.billId,
    title: bills.title,
    description: bills.description,
    billNumber: bills.billNumber,
  })
    .from(billTenants)
    .innerJoin(bills, eq(billTenants.billId, bills.billId))
    .where(and(
      eq(billTenants.tenantId, tenantId),
      isNull(billTenants.matchType),
    ))
    .all()

  // Evaluate keyword match. Stop once we hit the cap.
  const newlyMatched: number[] = []
  for (const row of candidates) {
    const hay = `${row.title ?? ''} ${row.description ?? ''} ${row.billNumber ?? ''}`
    if (matchesUnion(hay, keywords).matched) {
      newlyMatched.push(row.billId)
      if (newlyMatched.length >= SYNC_KEYWORDS_CAP) break
    }
  }
  const truncated = newlyMatched.length >= SYNC_KEYWORDS_CAP

  // Promote match_type='keyword' in batches. Guard against overwriting manual rows.
  const FLUSH_BATCH = 500
  const updateStmts = newlyMatched.map(billId =>
    db.update(billTenants)
      .set({ matchType: 'keyword' })
      .where(and(
        eq(billTenants.billId, billId),
        eq(billTenants.tenantId, tenantId),
        isNull(billTenants.matchType),
      ))
  )
  for (let i = 0; i < updateStmts.length; i += FLUSH_BATCH) {
    const chunk = updateStmts.slice(i, i + FLUSH_BATCH) as [any, ...any[]]
    if (chunk.length > 0) await db.batch(chunk)
  }

  // Queue each newly-matched bill to the ingestor with forceAI:true.
  // The ingestor will call getBill() once per message (1 LegiScan API call per bill),
  // download text, then notify the tenant with forceAI so the tenant runs AI on full text.
  for (let i = 0; i < newlyMatched.length; i += 100) {
    const batch = newlyMatched.slice(i, i + 100).map(billId => ({
      body: { billId, forceAI: true } as LsIngestorMessage,
    }))
    await c.env.INGESTOR_QUEUE.sendBatch(batch)
  }

  return c.json({
    ok: true,
    tenantId,
    candidates: candidates.length,
    newlyMatched: newlyMatched.length,
    truncated,
  })
})

// POST /admin/fetch-missing-texts/:tenantId
// Finds all keyword-matched bills for a tenant that have no R2 text yet and
// queues each to the ingestor (skipFetch omitted → calls getBill()).
// Uses forceMetadata:true so the post-download tenant notification passes
// through DEMO_MODE queue gates.  ~1 LegiScan API call per bill.
adminLsRoutes.post('/fetch-missing-texts/:tenantId', async (c) => {
  const tenantId = c.req.param('tenantId')
  const db = drizzle(c.env.DB, { schema })

  const tenant = await db.select().from(tenants).where(eq(tenants.tenantId, tenantId)).get()
  if (!tenant) return c.json({ error: 'tenant not found' }, 404)

  // By default only queue keyword-matched/manual bills. Pass ?allBills=true to
  // include non-keyword bills (matchType IS NULL) — useful for demo catch-ups.
  const allBills = c.req.query('allBills') === 'true'

  // Bills for this tenant that have no bill_texts row with a non-null r2_key
  const rows = await db.select({ billId: schema.billTenants.billId })
    .from(schema.billTenants)
    .leftJoin(
      schema.billTexts,
      and(eq(schema.billTexts.billId, schema.billTenants.billId), isNotNull(schema.billTexts.r2Key)),
    )
    .where(and(
      eq(schema.billTenants.tenantId, tenantId),
      allBills ? undefined : isNotNull(schema.billTenants.matchType),  // optional matchType filter
      isNull(schema.billTexts.billId),           // LEFT JOIN miss → no R2 text found
    ))
    .all()

  let queued = 0
  for (let i = 0; i < rows.length; i += 100) {
    await c.env.INGESTOR_QUEUE.sendBatch(
      rows.slice(i, i + 100).map(r => ({
        body: { billId: r.billId, forceMetadata: true } as LsIngestorMessage,
      }))
    )
    if (i + 100 < rows.length) await new Promise(res => setTimeout(res, 200))
    queued += Math.min(100, rows.length - i)
  }

  return c.json({ ok: true, tenantId, queued, total: rows.length })
})

// One-time catch-up for stale stub data. For every bill_tenants row with
// match_type IS NULL for the given tenant, send a stubOnly queue message
// so the tenant refreshes its metadata from central's bills table.
// No LegiScan calls, no AI runs.
adminLsRoutes.post('/refresh-stubs/:tenantId', async (c) => {
  const db = drizzle(c.env.DB, { schema })
  const tenantId = c.req.param('tenantId')

  const tenant = await db.select().from(tenants).where(eq(tenants.tenantId, tenantId)).get()
  if (!tenant) return c.json({ error: 'tenant not found' }, 404)

  const stubLinks = await db.select({ billId: billTenants.billId })
    .from(billTenants)
    .where(and(
      eq(billTenants.tenantId, tenantId),
      isNull(billTenants.matchType),
    ))
    .all()

  const bodies = stubLinks.map(l => ({
    tenantId,
    billId: `legiscan:${l.billId}`,
    stubOnly: true,
  } as LsNotificationMessage))

  // Binding-first, HTTP fallback by queue_id for tenants without a static binding.
  const outcome = await deliverBatchToTenant(c.env, tenantId, tenant.queueId ?? null, bodies)
  if (outcome === 'dropped' && bodies.length > 0) {
    return c.json({ error: `no delivery path for tenant ${tenantId} (no binding, no queue_id)` }, 400)
  }

  return c.json({ ok: true, tenantId, queued: bodies.length, via: outcome })
})

// POST /admin/backfill-stub-actions/:tenantId
// One-off heal for monitoring-only (match_type=null) bills whose latest action went stale
// because a raw pass advanced their change_hash before a full pass could refresh last_action
// (the pre-fix "swallow" bug). Unlike /refresh-stubs — which only re-sends stubOnly and would
// just re-deliver central's already-stale row — this re-pulls getMasterList for the tenant's
// covered sessions (1 LegiScan call per session), refreshes central's bills row for any stub
// whose action actually differs, then sends stubOnly so the tenant re-fetches fresh metadata.
// Zero getBill calls.
//
// Scope with ?sessionId=<id> to limit to one session (cheapest, 1 call). Without it, every
// session in the tenant's stateCoverage is checked; wildcard ('*') coverage REQUIRES an
// explicit ?sessionId to avoid an unbounded masterlist sweep.
adminLsRoutes.post('/backfill-stub-actions/:tenantId', async (c) => {
  const db = drizzle(c.env.DB, { schema })
  const tenantId = c.req.param('tenantId')
  const sessionIdParam = c.req.query('sessionId')

  const tenant = await db.select().from(tenants).where(eq(tenants.tenantId, tenantId)).get()
  if (!tenant) return c.json({ error: 'tenant not found' }, 404)

  // Fail fast if there's no delivery path — this route makes LegiScan calls
  // (quota) before notifying, so don't burn them on an undeliverable tenant.
  const hasDeliveryPath = !!getTenantQueue(c.env, tenantId) || (!!tenant.queueId && queuesRestEnabled(c.env))
  if (!hasDeliveryPath) return c.json({ error: `no delivery path for tenant ${tenantId} (no binding, no queue_id)` }, 400)

  // Resolve which sessions to check.
  let sessionIds: number[]
  if (sessionIdParam) {
    const sid = parseInt(sessionIdParam, 10)
    if (isNaN(sid)) return c.json({ error: 'invalid sessionId' }, 400)
    sessionIds = [sid]
  } else {
    let coverage: string[]
    try { coverage = JSON.parse(tenant.stateCoverage) } catch { coverage = [] }
    if (coverage.includes('*')) {
      return c.json({ error: 'wildcard tenant: pass ?sessionId=<id> to scope the backfill' }, 400)
    }
    if (coverage.length === 0) {
      return c.json({ ok: true, tenantId, sessionsChecked: 0, refreshed: 0, notified: 0 })
    }
    const rows = await db.select({ sessionId: sessions.sessionId })
      .from(sessions).where(inArray(sessions.state, coverage)).all()
    sessionIds = rows.map(r => r.sessionId)
  }

  const now = nowDb()
  // notifyIds accumulates all in-scope stub bill IDs (regardless of staleness) so
  // we always notify the tenant — even when central is already fresh for a session
  // (second-tenant scenario where another tenant's earlier run refreshed central).
  const notifyIds = new Set<number>()
  let refreshed = 0

  for (const sessionId of sessionIds) {
    // 1 LegiScan call per session — log it for quota tracking.
    db.insert(apiCallLog).values({
      loggedAt: now,
      callType: 'getMasterListBySession',
      params: JSON.stringify({ sessionId, reason: 'backfill-stub-actions', tenantId }),
    }).catch(err => console.error('[backfill-stub-actions] failed to log API call:', err))

    let list: Awaited<ReturnType<typeof getMasterListBySession>>
    try {
      list = await getMasterListBySession(sessionId, c.env.LEGISCAN_API_KEY)
    } catch (err) {
      console.error('[backfill-stub-actions] getMasterListBySession failed for session', sessionId, err)
      return c.json({ ok: false, error: 'masterlist_fetch_failed', sessionId }, 500)
    }
    if (list.length === 0) continue

    // This tenant's stub (match_type=null) links within this session.
    const billIds = list.map(b => b.bill_id)
    const stubBillIds = new Set<number>()
    for (let i = 0; i < billIds.length; i += 80) {
      const chunk = billIds.slice(i, i + 80)
      const links = await db.select({ billId: billTenants.billId })
        .from(billTenants)
        .where(and(
          eq(billTenants.tenantId, tenantId),
          isNull(billTenants.matchType),
          inArray(billTenants.billId, chunk),
        ))
        .all()
      for (const l of links) {
        stubBillIds.add(l.billId)
        notifyIds.add(l.billId)  // always notify, independent of central staleness
      }
    }
    if (stubBillIds.size === 0) continue

    // Stored rows for those stubs, to detect staleness against the live masterlist.
    const stored = new Map<number, { lastAction: string | null; lastActionDate: string | null; status: number }>()
    const stubIds = [...stubBillIds]
    for (let i = 0; i < stubIds.length; i += 80) {
      const chunk = stubIds.slice(i, i + 80)
      const rows = await db.select({
        billId: bills.billId,
        lastAction: bills.lastAction,
        lastActionDate: bills.lastActionDate,
        status: bills.status,
      }).from(bills).where(inArray(bills.billId, chunk)).all()
      for (const r of rows) {
        stored.set(r.billId, { lastAction: r.lastAction, lastActionDate: r.lastActionDate, status: r.status })
      }
    }

    const updates: any[] = []
    for (const entry of list) {
      if (!stubBillIds.has(entry.bill_id)) continue
      const s = stored.get(entry.bill_id)
      if (!s) continue
      // Compare actual action fields, NOT change_hash — the swallowed bills already have a
      // matching hash (that's the bug); their last_action is what's stale.
      const stale =
        s.lastAction !== (entry.last_action ?? null) ||
        s.lastActionDate !== (entry.last_action_date ?? null) ||
        s.status !== (entry.status ?? s.status)
      if (!stale) continue

      updates.push(
        db.update(bills).set({
          changeHash: entry.change_hash,
          title: entry.title ?? entry.number,
          description: entry.description ?? null,
          status: entry.status ?? s.status,
          statusDate: entry.status_date ?? null,
          lastAction: entry.last_action ?? null,
          lastActionDate: entry.last_action_date ?? null,
          url: entry.url ?? null,
          updatedAt: now,
        }).where(eq(bills.billId, entry.bill_id))
      )
    }

    for (let i = 0; i < updates.length; i += 500) {
      const chunk = updates.slice(i, i + 500) as [any, ...any[]]
      if (chunk.length > 0) await db.batch(chunk)
    }
    refreshed += updates.length
  }

  // Notify the tenant for ALL in-scope stubs — regardless of whether central was
  // stale. Decoupling refresh from notify fixes the second-tenant scenario: once
  // one tenant's run freshens central, a subsequent run for a different tenant
  // still notifies that tenant's stubs even though refreshed === 0.
  const notifyBodies = [...notifyIds].map(billId => (
    { tenantId, billId: `legiscan:${billId}`, stubOnly: true } as LsNotificationMessage
  ))

  let notified = 0
  try {
    // Binding-first, HTTP fallback by queue_id.
    await deliverBatchToTenant(c.env, tenantId, tenant.queueId ?? null, notifyBodies)
    notified = notifyBodies.length
  } catch (err) {
    console.error('[backfill-stub-actions] delivery failed after', notified, 'sent:', err)
    return c.json(
      { ok: false, error: 'queue_backpressure', sessionId: sessionIds[0] ?? null, refreshed, sent: notified },
      429,
      { 'Retry-After': '30' },
    )
  }

  return c.json({ ok: true, tenantId, sessionsChecked: sessionIds.length, refreshed, notified })
})

// POST /admin/update-bill-match-types/:tenantId
// Batch-update bill_tenants.match_type for a tenant. Accepts only 'manual' or null —
// 'keyword' promotion is handled by sync-keywords. Never downgrades 'manual' rows.
adminLsRoutes.post('/update-bill-match-types/:tenantId', guardCallerTenantParam(), async (c) => {
  const tenantId = c.req.param('tenantId')
  const db = drizzle(c.env.DB, { schema })

  const tenant = await db.select().from(tenants).where(eq(tenants.tenantId, tenantId)).get()
  if (!tenant) return c.json({ error: 'tenant not found' }, 404)

  const body = await c.req.json() as { updates: { externalId: string; matchType: 'manual' | null }[] }
  if (!Array.isArray(body?.updates) || body.updates.length === 0) {
    return c.json({ ok: true, updated: 0 })
  }

  const BATCH = 200
  let updated = 0

  for (let i = 0; i < body.updates.length; i += BATCH) {
    const chunk = body.updates.slice(i, i + BATCH)
    const stmts = chunk.flatMap(({ externalId, matchType }) => {
      const billId = parseInt(externalId.replace('legiscan:', ''), 10)
      if (isNaN(billId)) return []
      if (matchType === null) {
        // Only demote from 'keyword' — never touch 'manual' rows
        return [db.update(schema.billTenants)
          .set({ matchType: null })
          .where(and(
            eq(schema.billTenants.billId, billId),
            eq(schema.billTenants.tenantId, tenantId),
            eq(schema.billTenants.matchType, 'keyword'),
          ))]
      } else {
        // Promoting to 'manual' — always allowed
        return [db.update(schema.billTenants)
          .set({ matchType: 'manual' })
          .where(and(
            eq(schema.billTenants.billId, billId),
            eq(schema.billTenants.tenantId, tenantId),
          ))]
      }
    })
    if (stmts.length > 0) {
      await db.batch(stmts as [any, ...any[]])
      updated += stmts.length
    }
  }

  return c.json({ ok: true, updated })
})

// Re-ingest a single bill by LegiScan bill_id. Triggers a fresh getBill call
// and refreshes all child rows. Used to backfill data for individual bills.
adminLsRoutes.post('/reingest-bill/:billId', async (c) => {
  const billId = parseInt(c.req.param('billId'), 10)
  if (isNaN(billId)) return c.json({ error: 'invalid billId' }, 400)

  await c.env.INGESTOR_QUEUE.send({ billId } as LsIngestorMessage)
  return c.json({ ok: true, billId, queued: true })
})

// Re-ingest every fully-tracked bill for a tenant. Triggers a fresh getBill call
// for each bill, refreshing all child tables (supplements, amendments, history,
// sponsors, etc.).
//
// Filter: bill_tenants.match_type IN ('keyword','manual'). Monitoring-only stubs
// (match_type = null) are intentionally excluded — re-fetching them would burn
// API quota for data the UI doesn't surface.
//
// SAFETY: defaults to dry run. Pass ?confirm=true to actually queue. Each queued
// message triggers one getBill() LegiScan call — be mindful of the 30k/month quota.
adminLsRoutes.post('/reingest-tenant/:tenantId', async (c) => {
  const tenantId = c.req.param('tenantId')
  const confirm = c.req.query('confirm') === 'true'
  const db = drizzle(c.env.DB, { schema })

  const tenant = await db.select().from(tenants).where(eq(tenants.tenantId, tenantId)).get()
  if (!tenant) return c.json({ error: 'tenant not found' }, 404)

  const rows = await db.select({ billId: billTenants.billId })
    .from(billTenants)
    .where(and(
      eq(billTenants.tenantId, tenantId),
      isNotNull(billTenants.matchType),
    ))
    .all()

  if (!confirm) {
    return c.json({
      tenantId,
      matched: rows.length,
      wouldQueue: rows.length,
      dryRun: true,
      note: 'Pass ?confirm=true to actually queue. Each queued message triggers one getBill() LegiScan call.',
    })
  }

  let queued = 0
  const BATCH = 100
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH).map(r => ({
      body: { billId: r.billId } as LsIngestorMessage,
    }))
    if (batch.length > 0) {
      await c.env.INGESTOR_QUEUE.sendBatch(batch)
      queued += batch.length
    }
  }

  return c.json({ tenantId, matched: rows.length, queued, dryRun: false })
})
