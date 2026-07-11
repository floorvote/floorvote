import { Hono } from 'hono'
import { requireAdmin, type DashEnv } from '../lib/adminAuth'
import { drizzle } from 'drizzle-orm/d1'
import { sql, eq, gte, desc, inArray, isNull, and } from 'drizzle-orm'
import * as schema from '../db/schema-legiscan'
import { DEFAULT_FULL_HOURS_ET, DEFAULT_RAW_HOURS_ET } from '../lib/sync-schedule'
import { getSettingNumber } from '../lib/settings'
import { nowDb } from '../lib/dbTime'
import { fetchAiUsage } from '../lib/aiGatewayAnalytics'

export const dashRoutes = new Hono<DashEnv>()

dashRoutes.use('*', requireAdmin())

function parseHoursOrDefault(json: string | null, fallback: number[]): { hours: number[]; isDefault: boolean } {
  if (!json) return { hours: fallback, isDefault: true }
  try {
    const arr = JSON.parse(json)
    if (Array.isArray(arr) && arr.every(n => Number.isInteger(n) && n >= 0 && n < 24)) {
      return { hours: arr, isDefault: false }
    }
  } catch {}
  return { hours: fallback, isDefault: true }
}

function normalizeHours(input: unknown): number[] | null {
  if (!Array.isArray(input)) return null
  const out: number[] = []
  for (const v of input) {
    if (!Number.isInteger(v) || (v as number) < 0 || (v as number) > 23) return null
    out.push(v as number)
  }
  return Array.from(new Set(out)).sort((a, b) => a - b)
}

dashRoutes.get('/overview', async (c) => {
  const db = drizzle(c.env.DB, { schema })
  const legiscanLimit = await getSettingNumber(db, 'legiscan_monthly_limit', 30000)

  const tenantsRows = await db.select({ tenantId: schema.tenants.tenantId }).from(schema.tenants).all()

  // Bills tracked: count distinct billId in bill_tenants by match type
  const fullyTrackedRow = await db
    .select({ n: sql<number>`COUNT(DISTINCT ${schema.billTenants.billId})` })
    .from(schema.billTenants)
    .where(inArray(schema.billTenants.matchType, ['keyword', 'manual']))
    .get()
  const lightweightRow = await db
    .select({ n: sql<number>`COUNT(DISTINCT ${schema.billTenants.billId})` })
    .from(schema.billTenants)
    .where(isNull(schema.billTenants.matchType))
    .get()

  // API budget: count of api_call_log this month
  const monthStart = new Date()
  monthStart.setUTCDate(1)
  monthStart.setUTCHours(0, 0, 0, 0)
  const apiUsedRow = await db
    .select({ n: sql<number>`COUNT(*)` })
    .from(schema.apiCallLog)
    .where(gte(schema.apiCallLog.loggedAt, monthStart.toISOString()))
    .get()
  const apiUsed = Number(apiUsedRow?.n ?? 0)

  // Last sync (per-state syncs; we pick the most recent)
  const lastSync = await db
    .select()
    .from(schema.sessionSyncLog)
    .orderBy(desc(schema.sessionSyncLog.syncedAt))
    .limit(1)
    .get()

  return c.json({
    data: {
      tenants: { total: tenantsRows.length },
      bills: {
        fullyTracked: Number(fullyTrackedRow?.n ?? 0),
        lightweight: Number(lightweightRow?.n ?? 0),
      },
      apiBudget: {
        used: apiUsed,
        limit: legiscanLimit,
        pct: Math.round((apiUsed / legiscanLimit) * 1000) / 10, // one decimal
      },
      lastSync: lastSync
        ? {
            syncedAt: lastSync.syncedAt,
            ageSeconds: Math.floor((Date.now() - new Date(lastSync.syncedAt).getTime()) / 1000),
            state: lastSync.state,
            billsChecked: lastSync.billsChecked,
            billsChanged: lastSync.billsChanged,
            billsQueued: lastSync.billsQueued,
          }
        : null,
    },
    meta: { generatedAt: new Date().toISOString() },
  })
})

dashRoutes.get('/sync/keyword-union', async (c) => {
  const db = drizzle(c.env.DB, { schema })
  const tenants = await db.select().from(schema.tenants).all()
  const keywords = await db.select().from(schema.keywordRegistry).all()
  const keywordsByTenant = new Map<string, string[]>()
  for (const k of keywords) {
    if (!keywordsByTenant.has(k.tenantId)) keywordsByTenant.set(k.tenantId, [])
    keywordsByTenant.get(k.tenantId)!.push(k.keyword)
  }

  // All states with at least one session — used to expand `*` wildcard coverage.
  const allStateRows = await db.selectDistinct({ state: schema.sessions.state }).from(schema.sessions).all()
  const allStates = allStateRows.map(r => r.state).sort()

  const byState = new Map<string, { tenants: Set<string>; keywords: Set<string> }>()
  for (const t of tenants) {
    let coverage: string[] = []
    try { coverage = JSON.parse(t.stateCoverage ?? '[]') } catch {}
    const states = coverage.includes('*') ? allStates : coverage
    const ks = keywordsByTenant.get(t.tenantId) ?? []
    for (const s of states) {
      if (!byState.has(s)) byState.set(s, { tenants: new Set(), keywords: new Set() })
      const entry = byState.get(s)!
      entry.tenants.add(t.tenantId)
      for (const k of ks) entry.keywords.add(k.toLowerCase())
    }
  }

  const states = Array.from(byState.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([state, v]) => ({
      state,
      contributingTenants: Array.from(v.tenants).sort(),
      keywordCount: v.keywords.size,
      sampleKeywords: Array.from(v.keywords).sort().slice(0, 5),
    }))

  return c.json({ data: { states }, meta: { generatedAt: new Date().toISOString() } })
})

dashRoutes.get('/sync/sessions', async (c) => {
  const db = drizzle(c.env.DB, { schema })

  // Bill count per session via GROUP BY (single query, no correlated subquery).
  const billCountRows = await db
    .select({ sessionId: schema.bills.sessionId, n: sql<number>`COUNT(*)` })
    .from(schema.bills)
    .groupBy(schema.bills.sessionId)
    .all()
  const billCountBySession = new Map(billCountRows.map(r => [r.sessionId, Number(r.n)]))

  const allSessions = await db
    .select()
    .from(schema.sessions)
    .orderBy(schema.sessions.state, desc(schema.sessions.yearStart))
    .all()

  const shape = (r: typeof allSessions[number]) => {
    const full = parseHoursOrDefault(r.fullSyncHoursEt, DEFAULT_FULL_HOURS_ET)
    const raw = parseHoursOrDefault(r.rawSyncHoursEt, DEFAULT_RAW_HOURS_ET)
    return {
      sessionId: r.sessionId,
      state: r.state,
      sessionName: r.sessionName,
      yearStart: r.yearStart,
      yearEnd: r.yearEnd,
      lastSyncedAt: r.lastSyncedAt,
      fullSyncHours: full.hours,
      fullSyncIsDefault: full.isDefault,
      rawSyncHours: raw.hours,
      rawSyncIsDefault: raw.isDefault,
      syncEnabled: r.syncEnabled,
      sineDie: r.sineDie === 1,
      billCount: billCountBySession.get(r.sessionId) ?? 0,
    }
  }

  const active: ReturnType<typeof shape>[] = []
  const sineDie: ReturnType<typeof shape>[] = []
  for (const r of allSessions) {
    const shaped = shape(r)
    if (shaped.sineDie) sineDie.push(shaped)
    else active.push(shaped)
  }

  return c.json({
    data: { active, sineDie },
    meta: { generatedAt: new Date().toISOString() },
  })
})

dashRoutes.put('/sync/session/:sessionId', async (c) => {
  const db = drizzle(c.env.DB, { schema })
  const sessionId = Number(c.req.param('sessionId'))
  if (!Number.isInteger(sessionId)) return c.json({ error: { code: 'bad_request', message: 'invalid sessionId' } }, 400)

  const body = await c.req.json().catch(() => null) as
    | { fullSyncHoursEt?: unknown; rawSyncHoursEt?: unknown; syncEnabled?: unknown }
    | null
  if (!body) return c.json({ error: { code: 'bad_request', message: 'invalid body' } }, 400)

  const full = normalizeHours(body.fullSyncHoursEt)
  const raw = normalizeHours(body.rawSyncHoursEt)
  const syncEnabled = body.syncEnabled
  if (full === null || raw === null) {
    return c.json({ error: { code: 'bad_request', message: 'hours must be integers in [0,23]' } }, 400)
  }
  if (typeof syncEnabled !== 'boolean') {
    return c.json({ error: { code: 'bad_request', message: 'syncEnabled must be boolean' } }, 400)
  }
  if (syncEnabled && full.length === 0) {
    return c.json({ error: { code: 'bad_request', message: 'at least one full-sync hour required when enabled' } }, 400)
  }

  const session = await db.select().from(schema.sessions).where(eq(schema.sessions.sessionId, sessionId)).get()
  if (!session) return c.json({ error: { code: 'not_found', message: 'session not found' } }, 404)
  if (session.sineDie === 1) {
    return c.json({ error: { code: 'conflict', message: 'sine die sessions are not synced and cannot be edited' } }, 409)
  }

  await db.update(schema.sessions)
    .set({
      fullSyncHoursEt: JSON.stringify(full),
      rawSyncHoursEt: JSON.stringify(raw),
      syncEnabled,
    })
    .where(eq(schema.sessions.sessionId, sessionId))

  return c.json({ data: { sessionId, fullSyncHoursEt: full, rawSyncHoursEt: raw, syncEnabled }, meta: { updatedAt: new Date().toISOString() } })
})

const STALE_THRESHOLD_MS = 48 * 60 * 60 * 1000  // 48 hours

const STALE_HOURS = { billDelivery: 96, statsPull: 36, lastSeen: 48, stateSync: STALE_THRESHOLD_MS / 3_600_000 }

dashRoutes.get('/sync/states', async (c) => {
  const db = drizzle(c.env.DB, { schema })

  // Show every state with at least one session, not the union of tenant coverages.
  // This naturally includes wildcards (`*`) and surfaces all states the central is actually syncing.
  const stateRows = await db.selectDistinct({ state: schema.sessions.state }).from(schema.sessions).all()
  const states = new Set(stateRows.map(r => r.state))

  const result = []
  for (const state of states) {
    const activeSessionsRow = await db
      .select({ n: sql<number>`COUNT(*)` })
      .from(schema.sessions)
      .where(and(eq(schema.sessions.state, state), eq(schema.sessions.syncEnabled, true)))
      .get()

    const lastSync = await db
      .select({ at: schema.sessionSyncLog.syncedAt })
      .from(schema.sessionSyncLog)
      .where(eq(schema.sessionSyncLog.state, state))
      .orderBy(desc(schema.sessionSyncLog.syncedAt))
      .limit(1)
      .get()

    const lastBillChange = await db
      .select({ at: schema.billChangeLog.detectedAt })
      .from(schema.billChangeLog)
      .innerJoin(schema.bills, eq(schema.bills.billId, schema.billChangeLog.billId))
      .where(eq(schema.bills.state, state))
      .orderBy(desc(schema.billChangeLog.detectedAt))
      .limit(1)
      .get()

    const lastSyncMs = lastSync ? new Date(lastSync.at).getTime() : 0
    const stale = lastSyncMs === 0 || Date.now() - lastSyncMs > STALE_THRESHOLD_MS

    result.push({
      state,
      activeSessions: Number(activeSessionsRow?.n ?? 0),
      lastSyncedAt: lastSync?.at ?? null,
      lastBillChangeAt: lastBillChange?.at ?? null,
      stale,
    })
  }
  result.sort((a, b) => a.state.localeCompare(b.state))

  return c.json({ data: { states: result }, meta: { generatedAt: new Date().toISOString() } })
})

dashRoutes.get('/sync/api-budget', async (c) => {
  const db = drizzle(c.env.DB, { schema })
  const legiscanLimit = await getSettingNumber(db, 'legiscan_monthly_limit', 30000)
  const days = Math.min(Number(c.req.query('days') ?? 30), 90)

  // Monthly total
  const monthStart = new Date()
  monthStart.setUTCDate(1)
  monthStart.setUTCHours(0, 0, 0, 0)
  const mtdRow = await db
    .select({ n: sql<number>`COUNT(*)` })
    .from(schema.apiCallLog)
    .where(gte(schema.apiCallLog.loggedAt, monthStart.toISOString()))
    .get()

  // Daily series: last `days` days
  const since = new Date()
  since.setUTCHours(0, 0, 0, 0)
  since.setUTCDate(since.getUTCDate() - (days - 1))
  const dailyRows = await db
    .select({
      date: sql<string>`substr(${schema.apiCallLog.loggedAt}, 1, 10)`,
      calls: sql<number>`COUNT(*)`,
    })
    .from(schema.apiCallLog)
    .where(gte(schema.apiCallLog.loggedAt, since.toISOString()))
    .groupBy(sql`substr(${schema.apiCallLog.loggedAt}, 1, 10)`)
    .all()
  const dailyByDate = new Map<string, number>()
  for (const r of dailyRows) dailyByDate.set(r.date, Number(r.calls))
  const daily: { date: string; calls: number }[] = []
  for (let i = 0; i < days; i++) {
    const d = new Date(since)
    d.setUTCDate(since.getUTCDate() + i)
    const k = d.toISOString().slice(0, 10)
    daily.push({ date: k, calls: dailyByDate.get(k) ?? 0 })
  }

  // Top callTypes this month
  const topCalls = await db
    .select({
      callType: schema.apiCallLog.callType,
      calls: sql<number>`COUNT(*)`,
    })
    .from(schema.apiCallLog)
    .where(gte(schema.apiCallLog.loggedAt, monthStart.toISOString()))
    .groupBy(schema.apiCallLog.callType)
    .orderBy(desc(sql`COUNT(*)`))
    .limit(10)
    .all()

  // 90-day daily series (zero-filled), for cumulative chart
  const ninetyDaysAgo = new Date()
  ninetyDaysAgo.setUTCDate(ninetyDaysAgo.getUTCDate() - 89)
  ninetyDaysAgo.setUTCHours(0, 0, 0, 0)
  const monthDailyRows = await db
    .select({
      date: sql<string>`substr(${schema.apiCallLog.loggedAt}, 1, 10)`,
      calls: sql<number>`COUNT(*)`,
    })
    .from(schema.apiCallLog)
    .where(gte(schema.apiCallLog.loggedAt, ninetyDaysAgo.toISOString()))
    .groupBy(sql`substr(${schema.apiCallLog.loggedAt}, 1, 10)`)
    .all()
  const monthByDate = new Map<string, number>()
  for (const r of monthDailyRows) monthByDate.set(r.date, Number(r.calls))
  const todayKey = new Date().toISOString().slice(0, 10)
  const monthDaily: { date: string; calls: number }[] = []
  for (const cur = new Date(ninetyDaysAgo); cur.toISOString().slice(0, 10) <= todayKey; cur.setUTCDate(cur.getUTCDate() + 1)) {
    const k = cur.toISOString().slice(0, 10)
    monthDaily.push({ date: k, calls: monthByDate.get(k) ?? 0 })
  }

  return c.json({
    data: {
      monthToDate: Number(mtdRow?.n ?? 0),
      limit: legiscanLimit,
      daily,
      topCalls: topCalls.map(r => ({ callType: r.callType, calls: Number(r.calls) })),
      monthDaily,
    },
    meta: { generatedAt: new Date().toISOString() },
  })
})

// AI (Gemini) usage, read back from Cloudflare AI Gateway analytics. Fail-safe:
// returns { available: false, reason } when unconfigured or the query errors, so
// the Budget page degrades to a muted note instead of erroring.
dashRoutes.get('/budget/ai', async (c) => {
  try {
    const usage = await fetchAiUsage(c.env)
    return c.json({ data: { available: true, ...usage }, meta: { generatedAt: new Date().toISOString() } })
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e)
    console.warn('[budget/ai] unavailable:', reason)
    return c.json({ data: { available: false, reason }, meta: { generatedAt: new Date().toISOString() } })
  }
})

dashRoutes.get('/sync/ticks', async (c) => {
  const db = drizzle(c.env.DB, { schema })
  const limit = Math.min(Number(c.req.query('limit') ?? 50), 200)
  const rows = await db
    .select({
      id: schema.sessionSyncLog.id,
      sessionId: schema.sessionSyncLog.sessionId,
      sessionName: schema.sessionSyncLog.sessionName,
      state: schema.sessionSyncLog.state,
      syncedAt: schema.sessionSyncLog.syncedAt,
      billsChecked: schema.sessionSyncLog.billsChecked,
      billsChanged: schema.sessionSyncLog.billsChanged,
      billsQueued: schema.sessionSyncLog.billsQueued,
    })
    .from(schema.sessionSyncLog)
    .orderBy(desc(schema.sessionSyncLog.syncedAt))
    .limit(limit)
    .all()
  return c.json({ data: { syncs: rows }, meta: { generatedAt: new Date().toISOString() } })
})

dashRoutes.get('/tenants', async (c) => {
  const db = drizzle(c.env.DB, { schema })
  const tenants = await db.select().from(schema.tenants).all()

  // 1. Match-type counts grouped by tenant
  const matchRows = await db
    .select({
      tenantId: schema.billTenants.tenantId,
      matchType: schema.billTenants.matchType,
      n: sql<number>`COUNT(*)`,
    })
    .from(schema.billTenants)
    .groupBy(schema.billTenants.tenantId, schema.billTenants.matchType)
    .all()

  // 1b. Match-type counts grouped by (tenant, state) — used to drive the multi-state expand panel.
  const stateRows = await db
    .select({
      tenantId: schema.billTenants.tenantId,
      state: schema.bills.state,
      matchType: schema.billTenants.matchType,
      n: sql<number>`COUNT(*)`,
    })
    .from(schema.billTenants)
    .innerJoin(schema.bills, eq(schema.bills.billId, schema.billTenants.billId))
    .groupBy(schema.billTenants.tenantId, schema.bills.state, schema.billTenants.matchType)
    .all()

  // 2. Keyword counts grouped by tenant
  const kwRows = await db
    .select({
      tenantId: schema.keywordRegistry.tenantId,
      n: sql<number>`COUNT(*)`,
    })
    .from(schema.keywordRegistry)
    .groupBy(schema.keywordRegistry.tenantId)
    .all()

  // 3. Last bill ingested per tenant
  const lastBillRows = await db
    .select({
      tenantId: schema.billTenants.tenantId,
      at: sql<string>`MAX(${schema.bills.createdAt})`,
    })
    .from(schema.bills)
    .innerJoin(schema.billTenants, eq(schema.billTenants.billId, schema.bills.billId))
    .groupBy(schema.billTenants.tenantId)
    .all()

  // 4. Last activity per tenant
  const lastActivityRows = await db
    .select({
      tenantId: schema.billTenants.tenantId,
      at: sql<string>`MAX(${schema.bills.updatedAt})`,
    })
    .from(schema.bills)
    .innerJoin(schema.billTenants, eq(schema.billTenants.billId, schema.bills.billId))
    .groupBy(schema.billTenants.tenantId)
    .all()

  // Bucket results into maps
  const matchByTenant = new Map<string, { keyword: number; manual: number; null: number; total: number }>()
  for (const r of matchRows) {
    if (!matchByTenant.has(r.tenantId)) matchByTenant.set(r.tenantId, { keyword: 0, manual: 0, null: 0, total: 0 })
    const counts = matchByTenant.get(r.tenantId)!
    const n = Number(r.n)
    counts.total += n
    if (r.matchType === 'keyword') counts.keyword += n
    else if (r.matchType === 'manual') counts.manual += n
    else counts.null += n
  }
  const kwByTenant = new Map(kwRows.map(r => [r.tenantId, Number(r.n)]))
  const lastBillByTenant = new Map(lastBillRows.map(r => [r.tenantId, r.at]))
  const lastActivityByTenant = new Map(lastActivityRows.map(r => [r.tenantId, r.at]))

  // Bucket per-(tenant,state) counts
  type StateCounts = { state: string; keyword: number; manual: number; null: number; total: number }
  const stateByTenant = new Map<string, Map<string, StateCounts>>()
  for (const r of stateRows) {
    if (!stateByTenant.has(r.tenantId)) stateByTenant.set(r.tenantId, new Map())
    const m = stateByTenant.get(r.tenantId)!
    if (!m.has(r.state)) m.set(r.state, { state: r.state, keyword: 0, manual: 0, null: 0, total: 0 })
    const c = m.get(r.state)!
    const n = Number(r.n)
    c.total += n
    if (r.matchType === 'keyword') c.keyword += n
    else if (r.matchType === 'manual') c.manual += n
    else c.null += n
  }

  // Assemble response
  const out = tenants.map(t => {
    const states = (() => { try { return JSON.parse(t.stateCoverage ?? '[]') } catch { return [] } })()
    const stateMap = stateByTenant.get(t.tenantId)
    const stateBreakdown = stateMap
      ? Array.from(stateMap.values()).sort((a, b) => b.total - a.total)
      : []
    return {
      id: t.tenantId,
      name: t.name,
      states,
      billCounts: matchByTenant.get(t.tenantId) ?? { keyword: 0, manual: 0, null: 0, total: 0 },
      stateBreakdown,
      keywordCount: kwByTenant.get(t.tenantId) ?? 0,
      lastBillIngestedAt: lastBillByTenant.get(t.tenantId) ?? null,
      lastActivityAt: lastActivityByTenant.get(t.tenantId) ?? null,
    }
  }).sort((a, b) => a.id.localeCompare(b.id))

  return c.json({ data: { tenants: out }, meta: { generatedAt: new Date().toISOString() } })
})

dashRoutes.get('/tenants/:id', async (c) => {
  const id = c.req.param('id')
  const db = drizzle(c.env.DB, { schema })
  const tenant = await db.select().from(schema.tenants).where(eq(schema.tenants.tenantId, id)).get()
  if (!tenant) return c.json({ error: { code: 'not_found', message: 'Tenant not found' } }, 404)

  const states = (() => { try { return JSON.parse(tenant.stateCoverage ?? '[]') } catch { return [] } })()

  // matchTypeBreakdown
  const matchRows = await db
    .select({ matchType: schema.billTenants.matchType, n: sql<number>`COUNT(*)` })
    .from(schema.billTenants)
    .where(eq(schema.billTenants.tenantId, id))
    .groupBy(schema.billTenants.matchType)
    .all()
  const matchTypeBreakdown: Record<string, number> = { keyword: 0, manual: 0, null: 0 }
  for (const r of matchRows) {
    const key = r.matchType ?? 'null'
    matchTypeBreakdown[key] = Number(r.n)
  }

  // textStatusBreakdown — aggregated in SQL over the tenant's bills (joined via
  // bill_tenants). Done as one grouped query rather than fetching every bill id and
  // running inArray(): D1 caps bound params at ~100 and large tenants track tens of
  // thousands of bills, which 500'd this route ("Failed query … in (?, ?, …)").
  const textRow = await db
    .select({
      notChecked: sql<number>`COALESCE(SUM(CASE WHEN ${schema.bills.textsFetchedAt} IS NULL THEN 1 ELSE 0 END), 0)`,
      available:  sql<number>`COALESCE(SUM(CASE WHEN ${schema.bills.textsFetchedAt} IS NOT NULL AND EXISTS (SELECT 1 FROM bill_texts t WHERE t.bill_id = ${schema.bills.billId}) THEN 1 ELSE 0 END), 0)`,
      noTexts:    sql<number>`COALESCE(SUM(CASE WHEN ${schema.bills.textsFetchedAt} IS NOT NULL AND NOT EXISTS (SELECT 1 FROM bill_texts t WHERE t.bill_id = ${schema.bills.billId}) THEN 1 ELSE 0 END), 0)`,
    })
    .from(schema.bills)
    .innerJoin(schema.billTenants, eq(schema.billTenants.billId, schema.bills.billId))
    .where(eq(schema.billTenants.tenantId, id))
    .get()
  const textStatusBreakdown = {
    not_checked: Number(textRow?.notChecked ?? 0),
    no_texts: Number(textRow?.noTexts ?? 0),
    available: Number(textRow?.available ?? 0),
  }

  // keywordEffectiveness — proxy via LIKE on bill titles
  const totalBills = matchTypeBreakdown.keyword + matchTypeBreakdown.manual + matchTypeBreakdown.null
  const keywordEffectiveness: { keyword: string; billCount: number; pct: number }[] = []
  // Skip for very large tenants (e.g. the all-state wildcard with tens of thousands
  // of bills): this is N keywords × a non-indexable LIKE scan and would blow the
  // worker time budget. The match/text breakdowns above are the primary signal.
  const keywords = totalBills <= 20000
    ? await db.select().from(schema.keywordRegistry).where(eq(schema.keywordRegistry.tenantId, id)).all()
    : []
  for (const k of keywords) {
    const row = await db
      .select({ n: sql<number>`COUNT(DISTINCT ${schema.bills.billId})` })
      .from(schema.bills)
      .innerJoin(schema.billTenants, eq(schema.billTenants.billId, schema.bills.billId))
      .where(sql`${schema.billTenants.tenantId} = ${id} AND (
  LOWER(${schema.bills.title}) LIKE ${'%' + k.keyword.toLowerCase() + '%'}
  OR LOWER(COALESCE(${schema.bills.description}, '')) LIKE ${'%' + k.keyword.toLowerCase() + '%'}
)`)
      .get()
    const billCount = Number(row?.n ?? 0)
    keywordEffectiveness.push({
      keyword: k.keyword,
      billCount,
      pct: totalBills ? Math.round((billCount / totalBills) * 1000) / 10 : 0,
    })
  }
  keywordEffectiveness.sort((a, b) => b.billCount - a.billCount)

  // crossTenantBills — bills tracked by this tenant that are also tracked by other tenants
  // Only count fully-tracked rows (keyword or manual); stubs (matchType = null) don't count as "tracked by"
  // Single query with subqueries (no inArray over all bill ids, so it scales to
  // tenants with tens of thousands of bills). The HAVING COUNT(DISTINCT tenant_id) > 1
  // subquery limits the result to genuinely cross-tracked bills; the second restricts
  // to bills this tenant tracks. The join carries state/bill_number, so no separate
  // billMeta lookup is needed.
  const crossRows = await db
    .select({
      billId: schema.billTenants.billId,
      tenantId: schema.billTenants.tenantId,
      state: schema.bills.state,
      billNumber: schema.bills.billNumber,
    })
    .from(schema.billTenants)
    .innerJoin(schema.bills, eq(schema.bills.billId, schema.billTenants.billId))
    .where(and(
      inArray(schema.billTenants.matchType, ['keyword', 'manual']),
      sql`${schema.billTenants.billId} IN (SELECT bill_id FROM bill_tenants WHERE match_type IN ('keyword','manual') GROUP BY bill_id HAVING COUNT(DISTINCT tenant_id) > 1)`,
      sql`${schema.billTenants.billId} IN (SELECT bill_id FROM bill_tenants WHERE tenant_id = ${id} AND match_type IN ('keyword','manual'))`,
    ))
    .all()
  const byBill = new Map<number, { tenants: Set<string>; state: string; billNumber: string }>()
  for (const r of crossRows) {
    if (!byBill.has(r.billId)) byBill.set(r.billId, { tenants: new Set(), state: r.state, billNumber: r.billNumber })
    byBill.get(r.billId)!.tenants.add(r.tenantId)
  }
  const crossTenantBills: any[] = []
  for (const [billId, info] of byBill) {
    const others = Array.from(info.tenants).filter(t => t !== id).sort()
    if (others.length === 0) continue
    crossTenantBills.push({ billId, state: info.state, billNumber: info.billNumber, alsoTrackedBy: others })
  }
  crossTenantBills.sort((a, b) => b.alsoTrackedBy.length - a.alsoTrackedBy.length)

  return c.json({
    data: {
      tenant: { id, name: tenant.name, states },
      matchTypeBreakdown,
      textStatusBreakdown,
      keywordEffectiveness,
      crossTenantBills,
    },
    meta: { generatedAt: new Date().toISOString() },
  })
})

dashRoutes.get('/activity', async (c) => {
  const db = drizzle(c.env.DB, { schema })
  const limit = Math.min(Number(c.req.query('limit') ?? 50), 200)
  const offset = Math.max(Number(c.req.query('offset') ?? 0), 0)
  const stateParam = c.req.query('state')
  const changeTypeParam = c.req.query('changeType')
  const states = stateParam ? stateParam.split(',').map(s => s.trim()).filter(Boolean) : null
  const changeTypes = changeTypeParam ? changeTypeParam.split(',').map(s => s.trim()).filter(Boolean) : null

  const conds = []
  if (changeTypes && changeTypes.length) conds.push(inArray(schema.billChangeLog.changeType, changeTypes))
  if (states && states.length) conds.push(inArray(schema.bills.state, states))

  const rows = await db
    .select({
      billId: schema.billChangeLog.billId,
      changeType: schema.billChangeLog.changeType,
      oldValue: schema.billChangeLog.oldValue,
      newValue: schema.billChangeLog.newValue,
      detail: schema.billChangeLog.detail,
      detectedAt: schema.billChangeLog.detectedAt,
      state: schema.bills.state,
      billNumber: schema.bills.billNumber,
    })
    .from(schema.billChangeLog)
    .innerJoin(schema.bills, eq(schema.bills.billId, schema.billChangeLog.billId))
    .where(conds.length > 0 ? and(...conds) : undefined)
    .orderBy(desc(schema.billChangeLog.detectedAt))
    .limit(limit)
    .offset(offset)
    .all()

  return c.json({
    data: { entries: rows, hasMore: rows.length === limit },
    meta: { generatedAt: new Date().toISOString() },
  })
})

// Detailed bill_change_log entries attributed to a single sync tick.
// The sync_tick writes its row right after queuing changed bills, but bill_change_log entries
// are written *later* by the ingestor consumer as each queued bill is processed. So changes from
// this sync land in the window AFTER syncedAt, bounded by the next sync of the same session.
dashRoutes.get('/ops-health', async (c) => {
  const db = drizzle(c.env.DB, { schema })
  const nowMs = Date.now()
  const hoursSince = (iso: string | null): number | null =>
    iso ? (nowMs - new Date(iso).getTime()) / 3_600_000 : null
  const isStale = (iso: string | null, limit: number): boolean => {
    const h = hoursSince(iso)
    return h === null || h > limit
  }

  const tenants = await db.select().from(schema.tenants).all()

  const billRows = await db
    .select({ tenantId: schema.billTenants.tenantId, last: sql<string>`MAX(${schema.billTenants.notifiedAt})` })
    .from(schema.billTenants)
    .groupBy(schema.billTenants.tenantId)
    .all()
  const lastBillByTenant = new Map(billRows.map(r => [r.tenantId, r.last]))

  const statsRows = await db
    .select({ tenantId: schema.tenantStats.tenantId, last: sql<string>`MAX(${schema.tenantStats.pulledAt})` })
    .from(schema.tenantStats)
    .groupBy(schema.tenantStats.tenantId)
    .all()
  const lastStatsByTenant = new Map(statsRows.map(r => [r.tenantId, r.last]))

  const tenantHealth = tenants.map(t => {
    const lastBillDeliveredAt = lastBillByTenant.get(t.tenantId) ?? null
    const lastStatsPullAt = lastStatsByTenant.get(t.tenantId) ?? null
    const stale =
      isStale(lastBillDeliveredAt, STALE_HOURS.billDelivery) ||
      isStale(lastStatsPullAt, STALE_HOURS.statsPull) ||
      isStale(t.lastSeenAt, STALE_HOURS.lastSeen)
    return {
      tenantId: t.tenantId,
      name: t.name,
      active: t.active,
      lastBillDeliveredAt,
      lastStatsPullAt,
      lastSeenAt: t.lastSeenAt,
      stale,
    }
  })

  const activeSessions = await db.select().from(schema.sessions).where(eq(schema.sessions.sineDie, 0)).all()
  const lastSyncByState = new Map<string, string | null>()
  for (const s of activeSessions) {
    if (!s.syncEnabled) continue
    const prev = lastSyncByState.get(s.state) ?? null
    if (!prev || (s.lastSyncedAt && s.lastSyncedAt > prev)) lastSyncByState.set(s.state, s.lastSyncedAt)
  }
  const states = Array.from(lastSyncByState.entries())
    .map(([state, lastSyncedAt]) => ({ state, lastSyncedAt, stale: isStale(lastSyncedAt, STALE_HOURS.stateSync) }))
    .sort((a, b) => a.state.localeCompare(b.state))

  return c.json({
    data: { tenants: tenantHealth, states, thresholds: STALE_HOURS },
    meta: { generatedAt: new Date().toISOString() },
  })
})

dashRoutes.get('/sync/ticks/:id/changes', async (c) => {
  const db = drizzle(c.env.DB, { schema })
  const id = Number(c.req.param('id'))
  if (!Number.isFinite(id)) return c.json({ error: { code: 'bad_request', message: 'invalid id' } }, 400)

  const tick = await db.select().from(schema.sessionSyncLog).where(eq(schema.sessionSyncLog.id, id)).get()
  if (!tick) return c.json({ error: { code: 'not_found', message: 'sync tick not found' } }, 404)

  // Next sync of the same session — bounds the upper end of the window. If there is no next
  // sync yet, window is open-ended through now.
  const next = await db
    .select({ syncedAt: schema.sessionSyncLog.syncedAt })
    .from(schema.sessionSyncLog)
    .where(and(
      eq(schema.sessionSyncLog.sessionId, tick.sessionId),
      gte(schema.sessionSyncLog.syncedAt, tick.syncedAt),
      sql`${schema.sessionSyncLog.id} != ${id}`,
    ))
    .orderBy(schema.sessionSyncLog.syncedAt)
    .limit(1)
    .get()

  // synced_at / detected_at are stored in space format; keep the fallback in the
  // same shape so the windowEnd range compare below stays correct.
  const windowEnd = next?.syncedAt ?? nowDb()

  const changes = await db
    .select({
      billId: schema.billChangeLog.billId,
      changeType: schema.billChangeLog.changeType,
      oldValue: schema.billChangeLog.oldValue,
      newValue: schema.billChangeLog.newValue,
      detail: schema.billChangeLog.detail,
      detectedAt: schema.billChangeLog.detectedAt,
      state: schema.bills.state,
      billNumber: schema.bills.billNumber,
    })
    .from(schema.billChangeLog)
    .innerJoin(schema.bills, eq(schema.bills.billId, schema.billChangeLog.billId))
    .where(and(
      eq(schema.bills.sessionId, tick.sessionId),
      sql`${schema.billChangeLog.detectedAt} > ${tick.syncedAt}`,
      sql`${schema.billChangeLog.detectedAt} <= ${windowEnd}`,
    ))
    .orderBy(desc(schema.billChangeLog.detectedAt))
    .limit(500)
    .all()

  return c.json({
    data: { changes, windowStart: tick.syncedAt, windowEnd },
    meta: { generatedAt: new Date().toISOString() },
  })
})
