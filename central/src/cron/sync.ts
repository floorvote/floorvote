import { eq, inArray } from 'drizzle-orm'
import { matchesUnion } from '../lib/keywords'
import { saveMasterlistCache } from '../lib/masterlistCache'
import { nowDb } from '../lib/dbTime'
import { sessions, bills, billTenants, tenants, keywordRegistry } from '../db/schema'
import type { BillProvider, NormalizedBillStub } from '../providers/types'
import type { Env, CentralDb, IngestorQueueMessage } from '../types'

export function shouldSyncState(lastSyncedAt: string | null, frequencyHours: number): boolean {
  if (!lastSyncedAt) return true
  const elapsed = Date.now() - new Date(lastSyncedAt).getTime()
  return elapsed >= frequencyHours * 60 * 60 * 1000
}

export async function runSync(env: Env, db: CentralDb, provider: BillProvider): Promise<void> {
  const activeTenants = await db.select().from(tenants).where(eq(tenants.active, true)).all()
  if (activeTenants.length === 0) return

  const explicitStates = new Set<string>()
  for (const tenant of activeTenants) {
    let coverage: string[]
    try { coverage = JSON.parse(tenant.stateCoverage) } catch { continue }
    if (!coverage.includes('*')) coverage.forEach(s => explicitStates.add(s))
  }

  const billedStateRows = await db
    .selectDistinct({ state: bills.state, tenantId: billTenants.tenantId })
    .from(billTenants)
    .innerJoin(bills, eq(bills.billId, billTenants.billId))
    .where(inArray(billTenants.tenantId, activeTenants.map(t => t.tenantId)))
    .all()

  const billedStatesByTenant = new Map<string, Set<string>>()
  for (const row of billedStateRows) {
    if (!billedStatesByTenant.has(row.tenantId)) billedStatesByTenant.set(row.tenantId, new Set())
    billedStatesByTenant.get(row.tenantId)!.add(row.state)
  }
  const billedStates = new Set(billedStateRows.map(r => r.state))
  const trackedStates = new Set([...explicitStates, ...billedStates])
  if (trackedStates.size === 0) return

  const kwRows = await db.select().from(keywordRegistry).all()
  const keywordsByTenant = new Map<string, string[]>()
  for (const row of kwRows) {
    if (!keywordsByTenant.has(row.tenantId)) keywordsByTenant.set(row.tenantId, [])
    keywordsByTenant.get(row.tenantId)!.push(row.keyword)
  }

  const tenantsByState = new Map<string, typeof activeTenants>()
  const keywordsByState = new Map<string, string[]>()
  for (const state of trackedStates) {
    const covering = activeTenants.filter(t => {
      let coverage: string[]
      try { coverage = JSON.parse(t.stateCoverage) } catch { return false }
      if (coverage.includes('*') || coverage.includes(state)) return true
      return billedStatesByTenant.get(t.tenantId)?.has(state) ?? false
    })
    tenantsByState.set(state, covering)
    const kws = new Set<string>()
    for (const t of covering) {
      for (const kw of keywordsByTenant.get(t.tenantId) ?? []) kws.add(kw)
    }
    keywordsByState.set(state, [...kws])
  }

  // Refresh sessions from provider for each tracked state
  for (const state of trackedStates) {
    try {
      await refreshSessions(state, db, provider)
    } catch (err) {
      console.error(`[sync] failed to refresh sessions for ${state}:`, err)
    }
  }

  // Re-load sessions after refresh
  const allSessions = await db.select().from(sessions)
    .where(inArray(sessions.state, [...trackedStates]))
    .all()

  const sessionsByState = new Map<string, typeof allSessions>()
  for (const session of allSessions) {
    if (!sessionsByState.has(session.state)) sessionsByState.set(session.state, [])
    sessionsByState.get(session.state)!.push(session)
  }

  for (const state of trackedStates) {
    const stateTenants = tenantsByState.get(state) ?? []
    const stateKeywords = keywordsByState.get(state) ?? []
    const stateSessions = sessionsByState.get(state) ?? []

    const hasAllModeTenant = stateTenants.some(t => t.ingestionMode === 'all')
    if (!hasAllModeTenant && stateKeywords.length === 0) continue

    for (const session of stateSessions) {
      const freqHours = session.sineDie ? session.recessSyncFrequencyHours : session.activeSyncFrequencyHours
      if (!shouldSyncState(session.lastSyncedAt, freqHours)) continue

      try {
        await syncSession(state, session, stateKeywords, stateTenants, env, db, provider)
        await db.update(sessions)
          .set({ lastSyncedAt: nowDb() })
          .where(eq(sessions.sessionId, session.sessionId))
      } catch (err) {
        console.error(`[sync] failed for ${state} session ${session.sessionId}:`, err)
      }
    }
  }
}

async function refreshSessions(state: string, db: CentralDb, provider: BillProvider): Promise<void> {
  const providerSessions = await provider.fetchSessions(state)

  for (const ps of providerSessions) {
    const sessionId = `${state.toLowerCase()}:${ps.identifier}`
    const isCurrent = !ps.endDate || new Date(ps.endDate) > new Date()
    const sineDie = !!ps.endDate && new Date(ps.endDate) < new Date()

    const yearStart = ps.startDate ? new Date(ps.startDate).getFullYear() : parseInt(ps.identifier) || new Date().getFullYear()
    const yearEnd = ps.endDate ? new Date(ps.endDate).getFullYear() : yearStart

    await db.insert(sessions).values({
      sessionId,
      state,
      identifier: ps.identifier,
      yearStart,
      yearEnd,
      sessionName: ps.name,
      classification: ps.classification,
      isCurrent,
      sineDie,
      provider: 'openstates',
    }).onConflictDoUpdate({
      target: sessions.sessionId,
      set: {
        sessionName: ps.name,
        classification: ps.classification,
        isCurrent,
        sineDie,
      },
    })
  }
}

async function syncSession(
  state: string,
  session: { sessionId: string; identifier: string; lastSyncedAt: string | null },
  stateKeywords: string[],
  stateTenants: { tenantId: string; stateCoverage: string; ingestionMode: string }[],
  env: Env,
  db: CentralDb,
  provider: BillProvider,
): Promise<void> {
  const since = session.lastSyncedAt ? new Date(session.lastSyncedAt) : new Date('2020-01-01')
  const stubsCollected: NormalizedBillStub[] = []

  for await (const stub of provider.fetchUpdatedBills(state, session.identifier, since)) {
    stubsCollected.push(stub)
  }

  if (stubsCollected.length === 0) return

  await saveMasterlistCache(env, session.sessionId, stubsCollected).catch(err =>
    console.error(`[sync] failed to save masterlist cache for ${session.sessionId}:`, err),
  )

  const BATCH = 80
  const existingMap = new Map<string, string>()
  const allIds = stubsCollected.map(s => s.id)
  for (let i = 0; i < allIds.length; i += BATCH) {
    const chunk = allIds.slice(i, i + BATCH)
    const rows = await db.select({ billId: bills.billId, updatedAt: bills.updatedAt })
      .from(bills)
      .where(inArray(bills.billId, chunk))
      .all()
    for (const r of rows) existingMap.set(r.billId, r.updatedAt)
  }

  const toQueue: IngestorQueueMessage[] = []
  const now = nowDb()

  for (const stub of stubsCollected) {
    if (existingMap.get(stub.id) === stub.updatedAt) continue

    await db.insert(bills).values({
      billId: stub.id,
      sessionId: session.sessionId,
      state,
      number: stub.number,
      title: stub.title,
      abstract: stub.abstract,
      status: stub.status,
      statusDate: stub.statusDate,
      lastAction: stub.lastAction,
      lastActionDate: stub.lastActionDate,
      openstatesUrl: stub.url,
      stateUrl: stub.stateUrl,
      updatedAt: stub.updatedAt,
      createdAt: now,
    }).onConflictDoUpdate({
      target: bills.billId,
      set: {
        title: stub.title,
        abstract: stub.abstract,
        status: stub.status,
        statusDate: stub.statusDate,
        lastAction: stub.lastAction,
        lastActionDate: stub.lastActionDate,
        openstatesUrl: stub.url,
        stateUrl: stub.stateUrl,
        updatedAt: stub.updatedAt,
      },
    })

    const text = `${stub.title} ${stub.abstract ?? ''}`
    let linkedToAnyTenant = false
    for (const tenant of stateTenants) {
      let coverage: string[]
      try { coverage = JSON.parse(tenant.stateCoverage) } catch { continue }
      if (!coverage.includes('*') && !coverage.includes(state)) continue

      if (tenant.ingestionMode === 'all') {
        await db.insert(billTenants)
          .values({ billId: stub.id, tenantId: tenant.tenantId, matchedKeyword: null })
          .onConflictDoNothing()
        linkedToAnyTenant = true
      } else {
        const tenantKws = stateKeywords
        const { matched, keyword } = matchesUnion(text, tenantKws)
        if (matched) {
          await db.insert(billTenants)
            .values({ billId: stub.id, tenantId: tenant.tenantId, matchedKeyword: keyword })
            .onConflictDoNothing()
          linkedToAnyTenant = true
        }
      }
    }

    if (linkedToAnyTenant) {
      toQueue.push({ billId: stub.id })
    }
  }

  if (toQueue.length > 0) {
    for (let i = 0; i < toQueue.length; i += 100) {
      await env.INGESTOR_QUEUE.sendBatch(
        toQueue.slice(i, i + 100).map(body => ({ body })),
      )
    }
    console.log(`[sync] ${state} session ${session.identifier}: queued ${toQueue.length} bills`)
  }
}
