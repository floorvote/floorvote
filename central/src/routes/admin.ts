import { Hono } from 'hono'
import { drizzle } from 'drizzle-orm/d1'
import { eq, and, isNull, inArray, desc } from 'drizzle-orm'
import * as schema from '../db/schema'
import { matchesUnion } from '../lib/keywords'
import { loadMasterlistCache } from '../lib/masterlistCache'
import { getProvider } from '../providers/index'
import { secretsMatch } from '../lib/auth'
import { nowDb } from '../lib/dbTime'
import type { Env } from '../types'
import { getTenantQueue } from '../lib/tenantQueue'

export const adminRoutes = new Hono<{ Bindings: Env }>()

adminRoutes.use('*', async (c, next) => {
  if (!(await secretsMatch(c.req.header('x-admin-secret'), c.env.ADMIN_SECRET))) {
    return c.json({ error: 'unauthorized' }, 401)
  }
  return next()
})

adminRoutes.post('/notify-unnotified/:tenantId', async (c) => {
  const tenantId = c.req.param('tenantId')
  const db = drizzle(c.env.DB, { schema })

  const unnotified = await db
    .select({ billId: schema.billTenants.billId })
    .from(schema.billTenants)
    .where(and(eq(schema.billTenants.tenantId, tenantId), isNull(schema.billTenants.notifiedAt)))
    .all()

  if (unnotified.length === 0) return c.json({ queued: 0 })

  const queue = getTenantQueue(c.env, tenantId)
  if (!queue) return c.json({ error: `no queue binding for tenant ${tenantId}` }, 400)

  const now = nowDb()
  const BATCH_SIZE = 100

  for (let i = 0; i < unnotified.length; i += BATCH_SIZE) {
    const batch = unnotified.slice(i, i + BATCH_SIZE)
    await queue.sendBatch(
      batch.map((row) => ({ body: { tenantId, billId: row.billId } }))
    )
    for (const row of batch) {
      await db
        .update(schema.billTenants)
        .set({ notifiedAt: now })
        .where(and(eq(schema.billTenants.tenantId, tenantId), eq(schema.billTenants.billId, row.billId)))
    }
  }

  return c.json({ queued: unnotified.length })
})

adminRoutes.post('/reingest-tenant/:tenantId', async (c) => {
  const tenantId = c.req.param('tenantId')
  const db = drizzle(c.env.DB, { schema })

  const rows = await db
    .select({ billId: schema.billTenants.billId })
    .from(schema.billTenants)
    .where(eq(schema.billTenants.tenantId, tenantId))
    .all()

  const BATCH_SIZE = 100
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    await c.env.INGESTOR_QUEUE.sendBatch(
      rows.slice(i, i + BATCH_SIZE).map((r) => ({
        body: { billId: r.billId },
      }))
    )
  }

  return c.json({ queued: rows.length })
})

// Reprocess tenant using existing central data — bypasses OpenStates API, safe under rate limits
adminRoutes.post('/reprocess-tenant/:tenantId', async (c) => {
  const tenantId = c.req.param('tenantId')
  const db = drizzle(c.env.DB, { schema })
  const queue = getTenantQueue(c.env, tenantId)
  if (!queue) return c.json({ error: `no queue binding for tenant ${tenantId}` }, 400)

  const rows = await db
    .select({ billId: schema.billTenants.billId })
    .from(schema.billTenants)
    .where(eq(schema.billTenants.tenantId, tenantId))
    .all()

  const BATCH_SIZE = 100
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    await queue.sendBatch(
      rows.slice(i, i + BATCH_SIZE).map((r) => ({
        body: { tenantId, billId: r.billId, forceMetadata: true },
      }))
    )
  }

  return c.json({ queued: rows.length })
})

adminRoutes.post('/keyword-resync-tenant/:tenantId', async (c) => {
  const tenantId = c.req.param('tenantId')
  const db = drizzle(c.env.DB, { schema })

  const tenant = await db.select().from(schema.tenants).where(eq(schema.tenants.tenantId, tenantId)).get()
  if (!tenant) return c.json({ error: 'tenant not found' }, 404)

  const coverage: string[] = JSON.parse(tenant.stateCoverage)
  const hasWildcard = coverage.includes('*')

  const kwRows = await db.select().from(schema.keywordRegistry).where(eq(schema.keywordRegistry.tenantId, tenantId)).all()
  const keywords = kwRows.map(r => r.keyword)
  if (keywords.length === 0) return c.json({ queued: 0, note: 'no keywords configured' })

  const linkedRows = await db
    .select({ billId: schema.billTenants.billId })
    .from(schema.billTenants)
    .where(eq(schema.billTenants.tenantId, tenantId))
    .all()
  const linkedBillIds = new Set<string>(linkedRows.map(r => r.billId))

  const BATCH = 80
  const linkedArr = [...linkedBillIds]
  const sessionSet = new Map<string, string>()
  for (let i = 0; i < linkedArr.length; i += BATCH) {
    const chunk = linkedArr.slice(i, i + BATCH)
    const rows = await db
      .selectDistinct({ sessionId: schema.bills.sessionId, state: schema.bills.state })
      .from(schema.bills)
      .where(inArray(schema.bills.billId, chunk))
      .all()
    for (const r of rows) sessionSet.set(r.sessionId, r.state)
  }
  let sessionRows = [...sessionSet.entries()].map(([sessionId, state]) => ({ sessionId, state }))

  if (sessionRows.length === 0) {
    // New tenant with no bills yet — bootstrap from most recent session per covered state
    if (!hasWildcard) {
      const fallback: { sessionId: string; state: string }[] = []
      for (const state of coverage) {
        const session = await db
          .select({ sessionId: schema.sessions.sessionId, state: schema.sessions.state })
          .from(schema.sessions)
          .where(and(eq(schema.sessions.state, state), eq(schema.sessions.sineDie, false)))
          .orderBy(desc(schema.sessions.yearStart))
          .limit(1)
          .get()
        if (session) fallback.push(session)
      }
      sessionRows = fallback
    }
    if (sessionRows.length === 0) return c.json({ queued: 0 })
  }

  type Candidate = { title: string; abstract: string | null; inDb: boolean; sessionId: string; state: string; number: string }
  const candidateMap = new Map<string, Candidate>()

  const sessionIds = sessionRows.map(r => r.sessionId)

  const dbCandidates = await db
    .select({
      billId: schema.bills.billId,
      title: schema.bills.title,
      abstract: schema.bills.abstract,
      state: schema.bills.state,
      sessionId: schema.bills.sessionId,
      number: schema.bills.number,
    })
    .from(schema.bills)
    .where(inArray(schema.bills.sessionId, sessionIds))
    .all()

  for (const b of dbCandidates) {
    if (linkedBillIds.has(b.billId)) continue
    if (!hasWildcard && !coverage.includes(b.state)) continue
    candidateMap.set(b.billId, { title: b.title, abstract: b.abstract, inDb: true, sessionId: b.sessionId, state: b.state, number: b.number })
  }

  for (const { sessionId, state } of sessionRows) {
    if (!hasWildcard && !coverage.includes(state)) continue
    const cached = await loadMasterlistCache(c.env, sessionId)
    if (!cached) continue
    for (const entry of cached) {
      if (linkedBillIds.has(entry.id)) continue
      if (candidateMap.has(entry.id)) continue
      candidateMap.set(entry.id, {
        title: entry.title,
        abstract: entry.abstract,
        inDb: false,
        sessionId,
        state,
        number: entry.number,
      })
    }
  }

  const toLink: { billId: string; tenantId: string; matchedKeyword: string }[] = []
  const toQueue: { billId: string }[] = []
  const now = nowDb()

  for (const [billId, candidate] of candidateMap) {
    const text = `${candidate.title} ${candidate.abstract ?? ''}`
    const { matched, keyword } = matchesUnion(text, keywords)
    if (!matched) continue

    if (!candidate.inDb) {
      await db.insert(schema.bills)
        .values({
          billId,
          sessionId: candidate.sessionId,
          state: candidate.state,
          number: candidate.number,
          title: candidate.title,
          abstract: candidate.abstract,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing()
    }

    toLink.push({ billId, tenantId, matchedKeyword: keyword })
    toQueue.push({ billId })
  }

  console.log(`[keyword-resync] tenant=${tenantId} sessions=${sessionRows.length} candidates=${candidateMap.size} matched=${toLink.length}`)

  for (let i = 0; i < toLink.length; i += 25) {
    await db.insert(schema.billTenants).values(toLink.slice(i, i + 25)).onConflictDoNothing()
  }

  for (let i = 0; i < toQueue.length; i += 100) {
    await c.env.INGESTOR_QUEUE.sendBatch(
      toQueue.slice(i, i + 100).map((body) => ({ body })),
    )
  }

  return c.json({ queued: toQueue.length })
})

adminRoutes.put('/bills/:id{ocd-bill/[^/]+}/seed-text', async (c) => {
  const billId = c.req.param('id')
  const db = drizzle(c.env.DB, { schema })

  const bill = await db.select({ textR2Key: schema.bills.textR2Key })
    .from(schema.bills)
    .where(eq(schema.bills.billId, billId))
    .get()

  if (!bill) return c.json({ error: 'not found' }, 404)
  if (bill.textR2Key) return c.json({ ok: true, skipped: true })

  const contentType = c.req.header('content-type') ?? ''
  const isPdf = contentType.includes('application/pdf')

  const uuid = billId.replace('ocd-bill/', '')
  let r2Key: string

  if (isPdf) {
    const arrayBuffer = await c.req.arrayBuffer()
    if (arrayBuffer.byteLength === 0) return c.json({ error: 'body must not be empty' }, 400)
    r2Key = `bills/${uuid}/seed.pdf`
    await c.env.BILLS_BUCKET.put(r2Key, arrayBuffer, {
      httpMetadata: { contentType: 'application/pdf' },
    })
  } else {
    const text = await c.req.text()
    if (!text.trim()) return c.json({ error: 'body must not be empty' }, 400)
    r2Key = `bills/${uuid}/seed.txt`
    await c.env.BILLS_BUCKET.put(r2Key, text, {
      httpMetadata: { contentType: 'text/plain; charset=utf-8' },
    })
  }

  await db.update(schema.bills)
    .set({ textR2Key: r2Key })
    .where(eq(schema.bills.billId, billId))

  return c.json({ ok: true, r2Key })
})

adminRoutes.post('/ingest-bill', async (c) => {
  const body = await c.req.json<{ billId?: string }>().catch(() => ({} as { billId?: string }))
  if (!body.billId) return c.json({ error: 'billId is required' }, 400)

  const db = drizzle(c.env.DB, { schema })
  const provider = getProvider(c.env, db)
  const now = nowDb()

  const bill = await provider.fetchBillDetail(body.billId)

  await db.insert(schema.bills)
    .values({
      billId: body.billId,
      sessionId: `${bill.state.toLowerCase()}:${bill.session}`,
      state: bill.state,
      number: bill.number,
      title: bill.title,
      abstract: bill.abstract,
      status: bill.status,
      statusDate: bill.statusDate,
      openstatesUrl: bill.url,
      stateUrl: bill.stateUrl,
      providerData: JSON.stringify(bill),
      createdAt: now,
      updatedAt: bill.updatedAt,
    })
    .onConflictDoUpdate({
      target: schema.bills.billId,
      set: {
        providerData: JSON.stringify(bill),
        status: bill.status,
        statusDate: bill.statusDate,
        openstatesUrl: bill.url,
        stateUrl: bill.stateUrl,
        abstract: bill.abstract,
        updatedAt: bill.updatedAt,
      },
    })

  return c.json({ ok: true, billId: body.billId })
})
