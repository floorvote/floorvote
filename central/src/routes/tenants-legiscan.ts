import { Hono, type Context } from 'hono'
import { drizzle } from 'drizzle-orm/d1'
import { eq, and, isNull, inArray } from 'drizzle-orm'
import { matchesUnion } from '../lib/keywords'
import * as schema from '../db/schema-legiscan'
import { secretsMatch } from '../lib/auth'
import { nowDb } from '../lib/dbTime'
import type { LsEnv } from '../types-legiscan'
import { calendarBlockFromRows, type StoredCalendarRow } from '../lib/detect-changes'
import { getTenantQueue, tenantQueueBindingName } from '../lib/tenantQueue'
import { deliverBatchToTenant } from '../lib/tenantDelivery'
import { ensureQueue, queuesRestEnabled } from '../lib/queuesRest'
import { resolveTenantRpc } from '../lib/tenantRpc'
import { mergeCoverage } from '../lib/coverage'
import { isSafeTenantApiUrl } from '../lib/safeUrl'

const REPROCESS_LIMIT = 1000

export const tenantsLsRoutes = new Hono<{ Bindings: LsEnv }>()

tenantsLsRoutes.use('*', async (c, next) => {
  if (!(await secretsMatch(c.req.header('x-admin-secret'), c.env.ADMIN_SECRET))) {
    return c.json({ error: 'unauthorized' }, 401)
  }
  return next()
})

tenantsLsRoutes.post('/register', async (c) => {
  const body = await c.req.json<{
    tenantId: string
    name: string
    apiUrl: string
    stateCoverage: string[]
    keywords?: string[]
  }>()

  // H3: validate apiUrl before any DB write to prevent ADMIN_SECRET exfiltration
  // and SSRF. The engagement-pull cron fetches ${apiUrl}/api/internal/engagement-stats
  // with x-admin-secret, so an attacker-controlled URL would receive the secret.
  if (!body.apiUrl || !isSafeTenantApiUrl(body.apiUrl)) {
    return c.json(
      { error: 'apiUrl must be a valid https:// URL with a public DNS hostname (no IPs, localhost, or .local)' },
      400,
    )
  }

  const db = drizzle(c.env.DB, { schema })
  const now = nowDb()

  // H4: cross-tenant re-homing mitigation.
  // If a row already exists for this tenantId, reject the registration when the
  // incoming apiUrl has a different origin (scheme + hostname + port) than the
  // stored one. Legitimate re-registrations (restart, redeploy) keep the same
  // origin; only an attacker trying to redirect engagement-stats calls would
  // supply a different hostname.
  const existingForRehome = await db
    .select({ apiUrl: schema.tenants.apiUrl })
    .from(schema.tenants)
    .where(eq(schema.tenants.tenantId, body.tenantId))
    .get()
  if (existingForRehome?.apiUrl) {
    try {
      const storedOrigin = new URL(existingForRehome.apiUrl).origin
      const incomingOrigin = new URL(body.apiUrl).origin
      if (storedOrigin !== incomingOrigin) {
        return c.json(
          { error: 'apiUrl origin mismatch: re-registration cannot change the tenant origin' },
          400,
        )
      }
    } catch {
      // If either URL fails to parse (shouldn't happen after isSafeTenantApiUrl),
      // be conservative and reject.
      return c.json({ error: 'apiUrl origin comparison failed' }, 400)
    }
  }

  // Merge (don't overwrite) state_coverage. A tenant can accrue states from
  // seed-session that aren't in its association_config; overwriting here would
  // drop them on the next register and stop the cron polling them.
  const existingTenant = await db.select({ stateCoverage: schema.tenants.stateCoverage })
    .from(schema.tenants).where(eq(schema.tenants.tenantId, body.tenantId)).get()
  let existingCoverage: string[] | null = null
  if (existingTenant) {
    try { existingCoverage = JSON.parse(existingTenant.stateCoverage) } catch { existingCoverage = null }
  }
  const mergedCoverage = JSON.stringify(mergeCoverage(existingCoverage, body.stateCoverage))

  await db.insert(schema.tenants).values({
    tenantId:      body.tenantId,
    name:          body.name,
    apiUrl:        body.apiUrl,
    stateCoverage: mergedCoverage,
    active:        true,
    lastSeenAt:    now,
  }).onConflictDoUpdate({
    target: schema.tenants.tenantId,
    set: {
      name:          body.name,
      apiUrl:        body.apiUrl,
      lastSeenAt:    now,
      stateCoverage: mergedCoverage,
    },
  })

  if (body.keywords && body.keywords.length > 0) {
    await db.delete(schema.keywordRegistry)
      .where(eq(schema.keywordRegistry.tenantId, body.tenantId))
    for (const kw of body.keywords) {
      await db.insert(schema.keywordRegistry)
        .values({ tenantId: body.tenantId, keyword: kw })
        .onConflictDoNothing()
    }
  }

  // Dynamic delivery: resolve (or create) this tenant's Cloudflare queue and store
  // its id, so central can HTTP-publish bills without a hand-added TENANT_QUEUE_<ID>
  // binding + redeploy. The tenant's own consumer still binds the queue at deploy
  // time, so the queue normally already exists here and this just resolves its id.
  let queueId: string | null = null
  if (queuesRestEnabled(c.env)) {
    try {
      queueId = await ensureQueue(c.env, `floorvote-${body.tenantId}-queue`)
      if (queueId) {
        await db.update(schema.tenants)
          .set({ queueId })
          .where(eq(schema.tenants.tenantId, body.tenantId))
      }
    } catch (err) {
      console.error(`[register] failed to provision queue for "${body.tenantId}":`, err)
    }
  }

  // Surface a tenant with NO delivery path at all (no static binding and no
  // dynamic queue id) — its bills would be silently dropped at fan-out time.
  const queueBindingPresent = !!getTenantQueue(c.env, body.tenantId)
  if (!queueBindingPresent && !queueId) {
    console.warn(
      `[register] tenant "${body.tenantId}" has no queue binding ` +
      `(${tenantQueueBindingName(body.tenantId)}) and no dynamic queue id ` +
      `(set CF_QUEUES_TOKEN on central, or add a static binding) — its bills ` +
      `will be dropped until one is configured`,
    )
  }

  return c.json({ ok: true, queueBindingPresent, queueId })
})

// seed-session supports optional pagination via ?offset=N&limit=N (default limit=500).
// For large sessions (e.g. NJ with 10k bills) call repeatedly until done:true is returned.
// Each page inserts bill_tenants and queues the page's bills — safe to re-run (idempotent).
//
// ?skipQueue=true  — only create bill_tenants, skip all queue sends. Use when queues are
//                    rate-limited; follow up with reprocess once queues are clear.
tenantsLsRoutes.post('/seed-session/:tenantId', async (c) => {
  const tenantId  = c.req.param('tenantId')
  const sessionId = parseInt(c.req.query('sessionId')  ?? '0',     10)
  const offset    = parseInt(c.req.query('offset')     ?? '0',     10)
  const limit     = parseInt(c.req.query('limit')      ?? '500',   10)
  const skipQueue = c.req.query('skipQueue') === 'true'
  if (!sessionId) return c.json({ error: 'sessionId query param required' }, 400)

  const db = drizzle(c.env.DB, { schema })

  // Load keyword union for this tenant
  const kwRows = await db.select({ keyword: schema.keywordRegistry.keyword })
    .from(schema.keywordRegistry)
    .where(eq(schema.keywordRegistry.tenantId, tenantId))
    .all()
  const keywords = kwRows.map(r => r.keyword.toLowerCase())

  // Load one page of bills for the session
  const sessionBills = await db.select({
    billId:      schema.bills.billId,
    title:       schema.bills.title,
    description: schema.bills.description,
    billNumber:  schema.bills.billNumber,
  })
    .from(schema.bills)
    .where(eq(schema.bills.sessionId, sessionId))
    .limit(limit)
    .offset(offset)
    .all()

  if (sessionBills.length === 0) {
    return c.json({ ok: true, done: true, offset, processed: 0, keywordMatches: 0, nonKeyword: 0 })
  }

  const keywordMatchIds: number[] = []
  const nonKeywordIds: number[] = []
  for (const b of sessionBills) {
    const haystack = `${b.title ?? ''} ${b.description ?? ''} ${b.billNumber ?? ''}`
    const matched = keywords.length > 0 ? matchesUnion(haystack, keywords).matched : false
    if (matched) keywordMatchIds.push(b.billId)
    else nonKeywordIds.push(b.billId)
  }
  const keywordMatchIdSet = new Set(keywordMatchIds)

  // Bulk-insert bill_tenants — INSERT OR IGNORE so existing rows ('keyword', 'manual')
  // are never overwritten. D1 does not support WHERE in ON CONFLICT DO UPDATE.
  // D1 HTTP API limit: 100 bound params per query. Each row binds 3 (bill_id, tenant_id,
  // match_type), so max 33 rows per batch — use 30 to stay safely under.
  const INSERT_CHUNK = 30
  for (let i = 0; i < sessionBills.length; i += INSERT_CHUNK) {
    const slice = sessionBills.slice(i, i + INSERT_CHUNK)
    await db.insert(schema.billTenants)
      .values(slice.map(b => ({ billId: b.billId, tenantId, matchType: null as string | null })))
      .onConflictDoNothing()
  }

  // Promote null rows to 'keyword' for keyword-matching bills.
  // Does not touch 'manual' rows (WHERE matchType IS NULL ensures that).
  // promote: 2 params per row (tenant_id + bill_id) + 1 for match_type check = ~31 per chunk, fine.
  const PROMOTE_CHUNK = 50
  if (keywordMatchIds.length > 0) {
    for (let i = 0; i < keywordMatchIds.length; i += PROMOTE_CHUNK) {
      const chunk = keywordMatchIds.slice(i, i + PROMOTE_CHUNK)
      await db.update(schema.billTenants)
        .set({ matchType: 'keyword' })
        .where(and(
          eq(schema.billTenants.tenantId, tenantId),
          inArray(schema.billTenants.billId, chunk),
          isNull(schema.billTenants.matchType),
        ))
    }
  }

  // Demote previously-keyword-matched bills (for this tenant) that no longer match.
  // Only touch matchType='keyword' rows — never demote 'manual'. Scoped to bills in
  // the page just processed so a partial seed-session pass doesn't demote bills from
  // other pages we haven't visited yet.
  const pageBillIds = sessionBills.map(b => b.billId)
  const DEMOTE_CHUNK = 50  // inArray(billId, staleIds) + 2 WHERE params = ~52 max, under D1 limit
  for (let i = 0; i < pageBillIds.length; i += DEMOTE_CHUNK) {
    const chunk = pageBillIds.slice(i, i + DEMOTE_CHUNK)
    const staleIds = chunk.filter(id => !keywordMatchIdSet.has(id))
    if (staleIds.length === 0) continue
    await db.update(schema.billTenants)
      .set({ matchType: null })
      .where(and(
        eq(schema.billTenants.tenantId, tenantId),
        inArray(schema.billTenants.billId, staleIds),
        eq(schema.billTenants.matchType, 'keyword'),
      ))
  }

  // Ensure the tenant covers this session's state (once, on the first page).
  // seed-session previously linked bills without touching coverage, so the cron
  // never polled the state and the bills sat static. mergeCoverage is additive,
  // and /register also merges, so this isn't reverted by the tenant's next register.
  if (offset === 0) {
    const sessRow = await db.select({ state: schema.sessions.state })
      .from(schema.sessions).where(eq(schema.sessions.sessionId, sessionId)).get()
    const covRow = await db.select({ stateCoverage: schema.tenants.stateCoverage })
      .from(schema.tenants).where(eq(schema.tenants.tenantId, tenantId)).get()
    if (sessRow?.state && covRow) {
      let cov: string[] | null = null
      try { cov = JSON.parse(covRow.stateCoverage) } catch { cov = null }
      const merged = JSON.stringify(mergeCoverage(cov, [sessRow.state]))
      if (merged !== covRow.stateCoverage) {
        await db.update(schema.tenants).set({ stateCoverage: merged })
          .where(eq(schema.tenants.tenantId, tenantId))
      }
    }
  }

  const done = sessionBills.length < limit
  const nextOffset = done ? null : offset + sessionBills.length

  if (skipQueue) {
    return c.json({
      ok: true, done, offset, nextOffset,
      processed: sessionBills.length,
      keywordMatches: keywordMatchIds.length,
      nonKeyword: nonKeywordIds.length,
      queued: false,
    })
  }

  // Keyword-matching bills → ingestor with skipFetch (downloads text to R2, then notifies tenant)
  // Sequential sends to avoid queue rate limits
  try {
    for (let i = 0; i < keywordMatchIds.length; i += 100) {
      await c.env.INGESTOR_QUEUE.sendBatch(
        keywordMatchIds.slice(i, i + 100).map(billId => ({
          body: { billId, skipFetch: true, forceMetadata: true },
        }))
      )
    }
  } catch (err: any) {
    console.error('Error queuing to ingestor:', err)
    return c.json({ ok: false, error: String(err), offset, nextOffset, processed: sessionBills.length }, 429)
  }

  // Non-keyword bills → directly to tenant queue (metadata only, AI skipped by tenant).
  // Binding-first, HTTP fallback by queue_id for tenants onboarded without a binding.
  const tenantRow = await db.select({ queueId: schema.tenants.queueId })
    .from(schema.tenants)
    .where(eq(schema.tenants.tenantId, tenantId))
    .get()
  const nonKeywordBodies = nonKeywordIds.map(billId => ({
    tenantId, billId: `legiscan:${billId}`, forceMetadata: true,
  }))
  try {
    const outcome = await deliverBatchToTenant(c.env, tenantId, tenantRow?.queueId ?? null, nonKeywordBodies)
    if (outcome === 'dropped' && nonKeywordBodies.length > 0) {
      console.error(`[seed-session] no delivery path for tenant ${tenantId} — ${nonKeywordBodies.length} stub bills dropped`)
    }
  } catch (err: any) {
    console.error('Error queuing to tenant queue:', err)
    return c.json({ ok: false, error: String(err), offset, nextOffset, processed: sessionBills.length }, 429)
  }

  return c.json({
    ok: true, done, offset, nextOffset,
    processed:      sessionBills.length,
    keywordMatches: keywordMatchIds.length,
    nonKeyword:     nonKeywordIds.length,
  })
})

// Re-download HTML/PDF texts to R2 for bills that lost their r2_key.
// Uses skipFetch=true (zero LegiScan API calls). forceMetadata=false so
// DEMO_MODE tenants drop the notification and don't re-run AI.
// Only downloads text for keyword-matching bills — consistent with normal ingest.
tenantsLsRoutes.post('/redownload-texts/:tenantId', async (c) => {
  const tenantId = c.req.param('tenantId')
  const db = drizzle(c.env.DB, { schema })

  const kwRows = await db.select({ keyword: schema.keywordRegistry.keyword })
    .from(schema.keywordRegistry)
    .where(eq(schema.keywordRegistry.tenantId, tenantId))
    .all()
  const keywords = kwRows.map(r => r.keyword.toLowerCase())

  const rows = await db.selectDistinct({
    billId: schema.billTexts.billId,
    title: schema.bills.title,
    billNumber: schema.bills.billNumber,
  })
    .from(schema.billTexts)
    .innerJoin(schema.billTenants, eq(schema.billTexts.billId, schema.billTenants.billId))
    .innerJoin(schema.bills, eq(schema.billTexts.billId, schema.bills.billId))
    .where(and(eq(schema.billTenants.tenantId, tenantId), isNull(schema.billTexts.r2Key)))
    .all()

  const matching = keywords.length === 0
    ? []
    : rows.filter(r => matchesUnion(`${r.title ?? ''} ${r.billNumber}`, keywords).matched)

  let queued = 0
  for (let i = 0; i < matching.length; i += 100) {
    if (i > 0) await new Promise(r => setTimeout(r, 500))
    try {
      await c.env.INGESTOR_QUEUE.sendBatch(
        matching.slice(i, i + 100).map(r => ({
          body: { billId: r.billId, skipFetch: true, forceMetadata: false },
        }))
      )
      queued += Math.min(100, matching.length - i)
    } catch (err) {
      console.error(`[redownload-texts] sendBatch failed at offset ${i}:`, err)
      return c.json({ ok: false, queued, total: matching.length, error: String(err) }, 500)
    }
  }

  return c.json({ ok: true, queued, total: matching.length })
})

// POST /tenants/promote-bill/:tenantId/:billId — promote a stub bill to full tracking
// Sets bill_tenants.match_type='manual' (insert-or-update) and queues the ingestor
// with forceAI:true so the tenant re-runs the full AI pipeline on next process.
tenantsLsRoutes.post('/promote-bill/:tenantId/:billId', async (c) => {
  const db = drizzle(c.env.DB, { schema })
  const tenantId = c.req.param('tenantId')
  const billIdStr = c.req.param('billId')
  const billId = parseInt(billIdStr, 10)
  if (!Number.isInteger(billId) || billId <= 0) {
    return c.json({ error: 'invalid billId' }, 400)
  }

  const body = await c.req.json<{ interactive?: boolean }>().catch(() => ({} as { interactive?: boolean }))
  const interactive = body.interactive === true

  await db.insert(schema.billTenants)
    .values({ billId, tenantId, matchType: 'manual' })
    .onConflictDoUpdate({
      target: [schema.billTenants.billId, schema.billTenants.tenantId],
      set: { matchType: 'manual' },
    })

  await c.env.INGESTOR_QUEUE.send({ billId, forceAI: true, ...(interactive ? { interactive } : {}) })

  return c.json({ ok: true, tenantId, billId, matchType: 'manual' })
})

// POST /tenants/promote-bills/:tenantId — bulk-promote stub bills to full tracking.
// Body: { billIds: number[] }. Upserts bill_tenants.match_type='manual' for each and
// queues the ingestor with forceAI:true. Zero LegiScan API calls here, but the
// ingestor makes one getBill() per bill against the shared 30k/month quota — so
// the per-request count is capped at REPROCESS_LIMIT. (H4 quota guard: the
// deny-by-default TenantApi forwarder still lets a tenant reach this allowlisted
// route, so the cap, not the forwarder, is what bounds quota burn here.)
tenantsLsRoutes.post('/promote-bills/:tenantId', async (c) => {
  const db = drizzle(c.env.DB, { schema })
  const tenantId = c.req.param('tenantId')
  const body = await c.req.json<{ billIds?: number[] }>().catch(() => ({} as { billIds?: number[] }))
  const billIds = (body.billIds ?? []).filter(n => Number.isInteger(n) && n > 0)
  if (billIds.length > REPROCESS_LIMIT) {
    return c.json({ error: `too many billIds (max ${REPROCESS_LIMIT})` }, 400)
  }
  if (billIds.length === 0) return c.json({ ok: true, tenantId, promoted: 0 })

  await db.insert(schema.billTenants)
    .values(billIds.map(billId => ({ billId, tenantId, matchType: 'manual' as const })))
    .onConflictDoUpdate({
      target: [schema.billTenants.billId, schema.billTenants.tenantId],
      set: { matchType: 'manual' },
    })

  for (let i = 0; i < billIds.length; i += 100) {
    await c.env.INGESTOR_QUEUE.sendBatch(
      billIds.slice(i, i + 100).map(billId => ({ body: { billId, forceAI: true } }))
    )
  }

  return c.json({ ok: true, tenantId, promoted: billIds.length })
})

tenantsLsRoutes.get('/:tenantId/upcoming-hearings', async (c) => {
  const tenantId = c.req.param('tenantId')
  const daysRaw = Number(c.req.query('days') ?? '30')
  const days = Math.max(1, Math.min(365, Number.isFinite(daysRaw) ? daysRaw : 30))

  const today = new Date().toISOString().slice(0, 10)
  const end = new Date(Date.now() + days * 86400_000).toISOString().slice(0, 10)

  const rows = await c.env.DB.prepare(`
    SELECT
      bc.event_hash AS eventHash,
      bc.type AS type,
      bc.date AS date,
      bc.time AS time,
      bc.location AS location,
      bc.description AS description,
      bc.bill_id AS billId,
      b.bill_number AS billNumber,
      b.title AS billTitle,
      b.state AS state,
      s.session_name AS sessionName
    FROM bill_calendar bc
    INNER JOIN bill_tenants bt ON bt.bill_id = bc.bill_id AND bt.tenant_id = ?
    INNER JOIN bills b ON b.bill_id = bc.bill_id
    LEFT JOIN sessions s ON s.session_id = b.session_id
    WHERE bc.date >= ? AND bc.date <= ?
    ORDER BY bc.date ASC, COALESCE(bc.time, '99:99:99') ASC
  `).bind(tenantId, today, end).all()

  return c.json(rows.results ?? [])
})

tenantsLsRoutes.post('/reprocess/:tenantId', async (c) => {
  const tenantId = c.req.param('tenantId')
  const db = drizzle(c.env.DB, { schema })

  // Binding-first, HTTP-publish fallback by queue_id — same hybrid path the cron and
  // seed-session use, so dynamically-onboarded tenants (no static TENANT_QUEUE_<ID>
  // binding, e.g. nj) reprocess instead of silently 400ing.
  const hasBinding = !!getTenantQueue(c.env, tenantId)
  const tenantRow = await db.select({ queueId: schema.tenants.queueId })
    .from(schema.tenants)
    .where(eq(schema.tenants.tenantId, tenantId))
    .get()
  const queueId = tenantRow?.queueId ?? null
  if (!hasBinding && !(queueId && queuesRestEnabled(c.env))) {
    return c.json({ error: `no delivery path for tenant ${tenantId} (no queue binding or queue_id)` }, 400)
  }

  // Optional targeted filter: only these LegiScan bill_ids, each delivered WITH a
  // calendar block built from stored bill_calendar (the priority-bill backfill path).
  const body = await c.req.json().catch(() => ({})) as { billIds?: number[]; offset?: number; limit?: number }
  const targeted = Array.isArray(body.billIds)
  const offset = typeof body.offset === 'number' && body.offset >= 0 ? Math.floor(body.offset) : 0
  const pageLimit = typeof body.limit === 'number' && body.limit > 0
    ? Math.min(Math.floor(body.limit), REPROCESS_LIMIT)
    : REPROCESS_LIMIT

  let rows: { billId: number }[]
  if (targeted) {
    // Only bills actually linked to this tenant — ignore unknown/cross-tenant ids.
    const requested = body.billIds!
    rows = []
    for (let i = 0; i < requested.length; i += 100) {
      const owned = await db.select({ billId: schema.billTenants.billId })
        .from(schema.billTenants)
        .where(and(eq(schema.billTenants.tenantId, tenantId), inArray(schema.billTenants.billId, requested.slice(i, i + 100))))
        .all()
      rows.push(...owned)
    }
  } else {
    rows = await db.select({ billId: schema.billTenants.billId })
      .from(schema.billTenants)
      .where(eq(schema.billTenants.tenantId, tenantId))
      .orderBy(schema.billTenants.billId)
      .limit(pageLimit)
      .offset(offset)
      .all()
  }

  for (let i = 0; i < rows.length; i += 100) {
    if (i > 0) await new Promise(r => setTimeout(r, 100))
    const chunk = rows.slice(i, i + 100)

    // Calendar blocks are attached ONLY on the targeted path; untargeted reprocess
    // stays lean metadata-only to avoid bloating 10k+ messages.
    const calByBillId = new Map<number, StoredCalendarRow[]>()
    if (targeted) {
      const calRows = await db.select({
        billId:      schema.billCalendar.billId,
        typeId:      schema.billCalendar.typeId,
        description: schema.billCalendar.description,
        date:        schema.billCalendar.date,
        time:        schema.billCalendar.time,
        location:    schema.billCalendar.location,
        eventHash:   schema.billCalendar.eventHash,
      }).from(schema.billCalendar).where(inArray(schema.billCalendar.billId, chunk.map(r => r.billId))).all()
      for (const row of calRows) {
        const arr = calByBillId.get(row.billId) ?? []
        arr.push({ typeId: row.typeId, description: row.description, date: row.date, time: row.time, location: row.location, eventHash: row.eventHash })
        calByBillId.set(row.billId, arr)
      }
    }

    const bodies = chunk.map(r => {
      const msg: Record<string, unknown> = { tenantId, billId: `legiscan:${r.billId}`, forceMetadata: true }
      const cal = calByBillId.get(r.billId)
      if (targeted && cal && cal.length > 0) msg.calendar = calendarBlockFromRows(cal)
      return msg
    })
    const outcome = await deliverBatchToTenant(c.env, tenantId, queueId, bodies)
    // Invariant backstop: the upfront guard already rejects the no-delivery-path case,
    // so this can't normally fire — it only trips if that guard ever drifts from
    // deliverBatchToTenant's own binding/queueId logic.
    if (outcome === 'dropped') {
      return c.json({ error: `no delivery path for tenant ${tenantId}` }, 400)
    }
  }

  const hasMore = !targeted && rows.length === pageLimit
  return c.json({ ok: true, queued: rows.length, targeted, hasMore, nextOffset: offset + rows.length })
})

// Operator fan-out routes — authenticate via the `use('*')` secret middleware above.
// Each route resolves the per-tenant service binding and delegates via RPC.

// Operator fan-out: resolve the tenant binding, run an RPC method, and turn a
// tenant-side throw into a clean 502 (instead of a bare 500) so operators get a
// readable message (e.g. "demo mode not enabled", "Queue not configured").
async function tenantRpcCall<T>(
  c: Context<{ Bindings: LsEnv }>,
  fn: (rpc: import('../lib/tenantRpc').TenantRpc) => Promise<T>,
): Promise<Response> {
  const tenantId = c.req.param('tenantId')
  if (!tenantId) return c.json({ error: 'tenant id required' }, 400)
  const rpc = resolveTenantRpc(c.env, tenantId)
  if (!rpc) return c.json({ error: 'tenant not bound' }, 501)
  try {
    return c.json((await fn(rpc)) as Record<string, unknown>)
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'tenant call failed' }, 502)
  }
}

tenantsLsRoutes.post('/:tenantId/force-register', (c) =>
  tenantRpcCall(c, async (rpc) => ({ ok: await rpc.forceRegister() })))

tenantsLsRoutes.post('/:tenantId/demo-reset', (c) =>
  tenantRpcCall(c, (rpc) => rpc.demoReset()))

tenantsLsRoutes.post('/:tenantId/run-digest', (c) =>
  tenantRpcCall(c, (rpc) => rpc.runDigestNow()))

tenantsLsRoutes.post('/:tenantId/refresh-metadata', (c) =>
  tenantRpcCall(c, (rpc) => rpc.refreshMetadata()))

tenantsLsRoutes.post('/:tenantId/send-sample-email', async (c) => {
  const rpc = resolveTenantRpc(c.env, c.req.param('tenantId'))
  if (!rpc) return c.json({ error: 'tenant not bound' }, 501)
  const body = await c.req.json<{ to?: string; type?: string }>().catch(() => ({} as { to?: string; type?: string }))
  if (!body.to || !body.type) return c.json({ error: 'to and type required' }, 400)
  try {
    const r = await rpc.sendSampleEmail(body.to, body.type)
    return c.json(r, r.ok ? 200 : 502)
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'tenant call failed' }, 502)
  }
})
