import { eq, and, inArray, isNotNull } from 'drizzle-orm'
import { DEFAULT_PROVIDER_ID, getProvider, type Provider, type SessionRef, type SyncEntry } from '../providers'
import { sessions, bills, billTenants, tenants, keywordRegistry, sessionSyncLog } from '../db/schema'
import { matchesUnion } from '../lib/keywords'
import { decideMode, getCurrentEtHour } from '../lib/sync-schedule'
import { nowDb } from '../lib/dbTime'
import { providerContext } from '../lib/providerContext'
import { toHandle } from '../lib/billHandle'
import type { Env, Db, IngestorMessage, NotificationMessage } from '../types'
import { deliverBatchToTenant } from '../lib/tenantDelivery'
import { directStates } from '../lib/providerRouting'

const BATCH = 80
const FLUSH_BATCH = 500

/** The states active instances cover, which are the states central keeps in sync. */
export async function loadTrackedStates(
  db: Db,
  activeTenants: { stateCoverage: string }[],
): Promise<Set<string>> {
  const trackedStates = new Set<string>()
  const hasWildcard = activeTenants.some(t => {
    try { return (JSON.parse(t.stateCoverage) as string[]).includes('*') } catch { return false }
  })

  if (hasWildcard) {
    // Wildcard: trackedStates = exactly the states that have sessions in central DB.
    // Seeding a new state is sufficient — no manual stateCoverage update needed.
    const knownStates = await db.selectDistinct({ state: sessions.state }).from(sessions).all()
    for (const { state } of knownStates) trackedStates.add(state)
  } else {
    for (const t of activeTenants) {
      let coverage: string[]
      try { coverage = JSON.parse(t.stateCoverage) } catch { continue }
      for (const s of coverage) trackedStates.add(s)
    }
  }
  return trackedStates
}

export async function runSync(env: Env, db: Db): Promise<void> {
  const activeTenants = await db.select().from(tenants).where(eq(tenants.active, true)).all()
  if (activeTenants.length === 0) return

  const trackedStates = await loadTrackedStates(db, activeTenants)

  // States read from another provider are synced by that provider (cron/sync-snapshots.ts).
  for (const state of directStates(env)) trackedStates.delete(state)

  if (trackedStates.size === 0) return

  // States don't record their provider yet, so every state syncs from the default.
  const provider = getProvider(DEFAULT_PROVIDER_ID)

  const etHour = getCurrentEtHour()
  console.log(`[sync-ls] tick at ET hour ${etHour}`)

  // Discover new sessions once per day, at the first default full-pass hour (5 ET).
  // LegiScan sessions appear at most a few times per state per year; hourly refresh
  // would cost ~24 getSessionList calls/state/day for no benefit.
  if (etHour === 5) {
    for (const state of trackedStates) {
      try {
        await refreshSessions(state, provider, env, db)
      } catch (err) {
        console.error(`[sync-ls] failed to refresh sessions for ${state}:`, err)
      }
    }
  }

  // The provider's own sessions, by each row's `provider` column. Other
  // providers' sessions share this table: they are synced by their own
  // provider, and this one has never heard of their ids.
  const sessionRows = await db.select({
    sessionId: sessions.sessionId,
    state: sessions.state,
    provider: sessions.provider,
    sessionName: sessions.sessionName,
    sessionTag: sessions.sessionTag,
    yearStart: sessions.yearStart,
    yearEnd: sessions.yearEnd,
    sineDie: sessions.sineDie,
    syncEnabled: sessions.syncEnabled,
    fullSyncHoursEt: sessions.fullSyncHoursEt,
    rawSyncHoursEt: sessions.rawSyncHoursEt,
  })
    .from(sessions)
    .where(and(inArray(sessions.state, [...trackedStates]), eq(sessions.provider, provider.id)))
    .all()

  const tenantsByState = new Map<string, { tenantId: string; stateCoverage: string; queueId: string | null }[]>()
  for (const state of trackedStates) {
    const covering = activeTenants.filter(t => {
      let coverage: string[]
      try { coverage = JSON.parse(t.stateCoverage) } catch { return false }
      return coverage.includes('*') || coverage.includes(state)
    })
    tenantsByState.set(state, covering.map(t => ({
      tenantId: t.tenantId, stateCoverage: t.stateCoverage, queueId: t.queueId ?? null,
    })))
  }

  // Decide mode for each session up-front, then process in parallel so I/O waits
  // (D1 reads, queue sends, LegiScan calls) interleave across sessions instead
  // of stacking serially. Promise.allSettled ensures one session's failure
  // doesn't reject the whole batch.
  const sessionsToProcess = sessionRows
    .map(session => ({ session, mode: decideMode(session, etHour) }))
    // A provider with no cheap hash list has no raw pass: its sessions sync in
    // full-pass hours only.
    .filter(({ mode }) => mode === 'full' || (mode === 'raw' && !!provider.listChangeHashes))

  const tasks = sessionsToProcess.map(async ({ session, mode }) => {
    const coveringTenants = tenantsByState.get(session.state) ?? []
    if (coveringTenants.length === 0) {
      console.log(`[sync-ls] skip ${session.state}/${session.sessionId}: no covering tenants`)
      return
    }

    console.log(`[sync-ls] ${mode} pass: ${session.state}/${session.sessionId}`)
    try {
      if (mode === 'full') {
        await runFullPass(session, coveringTenants, provider, env, db)
      } else {
        await runRawPass(session, coveringTenants, provider, env, db)
      }
      await db.update(sessions)
        .set({ lastSyncedAt: nowDb() })
        .where(eq(sessions.sessionId, session.sessionId))
    } catch (err) {
      console.error(`[sync-ls] failed for session ${session.sessionId}:`, err)
    }
  })

  await Promise.allSettled(tasks)
}

async function refreshSessions(state: string, provider: Provider, env: Env, db: Db): Promise<void> {
  const providerSessions = await provider.listSessions(state, providerContext(provider, env, db))
  for (const s of providerSessions) {
    await db.insert(sessions).values({
      sessionId:    s.session_id,
      state,
      stateId:      s.state_id ?? 0,
      yearStart:    s.year_start,
      yearEnd:      s.year_end,
      prefile:      s.prefile ?? 0,
      sineDie:      s.sine_die ?? 0,
      prior:        s.prior ?? 0,
      special:      s.special ?? 0,
      sessionTag:   s.session_tag ?? '',
      sessionTitle: s.session_name,
      sessionName:  s.session_name,
      provider:     provider.id,
    }).onConflictDoUpdate({
      target: sessions.sessionId,
      set: {
        sessionTitle: s.session_name,
        sessionName:  s.session_name,
        sineDie:      s.sine_die ?? 0,
        prior:        s.prior ?? 0,
      },
    })
  }
}

async function runFullPass(
  session: SessionRef & { sessionName: string; provider: string },
  coveringTenants: { tenantId: string; stateCoverage: string; queueId: string | null }[],
  provider: Provider,
  env: Env,
  db: Db,
): Promise<void> {
  // runSync runs the default provider, which lists measures rather than snapshots.
  const list = await provider.listMeasures!(session, providerContext(provider, env, db))
  await applyMasterList(session, list, coveringTenants, env, db)
}

/**
 * Reconcile one session's master list against central: upsert bill rows,
 * update each covering tenant's keyword links, queue matched-and-changed bills
 * to the ingestor, and send monitor stubs for the rest. Provider-neutral: any
 * provider that can list a session's measures as `SyncEntry` rows, with a
 * `change_hash` that moves when the measure does, can drive the full pass.
 * Returns the bill ids it queued for the ingestor.
 */
export async function applyMasterList(
  /** `provider`, the session row's provider, is written to new bill rows. */
  session: { sessionId: number; state: string; sessionName: string; provider: string },
  list: SyncEntry[],
  coveringTenants: { tenantId: string; stateCoverage: string; queueId: string | null }[],
  env: Env,
  db: Db,
  ingestorQueue: Queue = env.INGESTOR_QUEUE,
  opts: {
    /**
     * Leave the bills row of a changed bill that is being queued for the
     * ingestor to update, instead of writing the masterlist's status and title
     * first. The ingestor diffs against the stored row, so a status written
     * here is a status_change it can no longer see. The snapshot sync sets this,
     * because every one of its passes is a full pass.
     */
    deferQueuedUpdates?: boolean
  } = {},
): Promise<number[]> {
  if (list.length === 0) {
    await db.insert(sessionSyncLog).values({
      syncedAt: nowDb(),
      state: session.state,
      sessionId: session.sessionId,
      sessionName: session.sessionName,
      billsChecked: 0,
      billsChanged: 0,
      billsQueued: 0,
    })
    return []
  }

  // Per-tenant keyword sets
  const tenantIds = coveringTenants.map(t => t.tenantId)
  const kwRows = tenantIds.length > 0
    ? await db.select({ tenantId: keywordRegistry.tenantId, keyword: keywordRegistry.keyword })
        .from(keywordRegistry).where(inArray(keywordRegistry.tenantId, tenantIds)).all()
    : []
  const keywordsByTenant = new Map<string, string[]>()
  for (const r of kwRows) {
    const arr = keywordsByTenant.get(r.tenantId) ?? []
    arr.push(r.keyword.toLowerCase())
    keywordsByTenant.set(r.tenantId, arr)
  }

  // Load existing bills + bill_tenants links in chunks
  const billIds = list.map(b => b.bill_id)
  const existing = new Map<number, { changeHash: string }>()
  const existingLinks = new Map<string, string | null>()
  for (let i = 0; i < billIds.length; i += BATCH) {
    const chunk = billIds.slice(i, i + BATCH)
    const rows = await db.select({ billId: bills.billId, changeHash: bills.changeHash })
      .from(bills).where(inArray(bills.billId, chunk)).all()
    for (const r of rows) existing.set(r.billId, { changeHash: r.changeHash })

    const links = await db.select({
      billId: billTenants.billId,
      tenantId: billTenants.tenantId,
      matchType: billTenants.matchType,
    }).from(billTenants).where(inArray(billTenants.billId, chunk)).all()
    for (const r of links) existingLinks.set(`${r.billId}:${r.tenantId}`, r.matchType ?? null)
  }

  const now = nowDb()
  const billStmts: any[] = []
  const billTenantStmts: any[] = []
  const toQueue = new Set<number>()
  const stubMessagesByTenant = new Map<string, NotificationMessage[]>()
  const queueIdByTenant = new Map(coveringTenants.map(t => [t.tenantId, t.queueId]))
  let changedCount = 0

  for (const entry of list) {
    const stored = existing.get(entry.bill_id)
    const isNew = !stored
    const billChanged = !stored || stored.changeHash !== entry.change_hash
    if (isNew || billChanged) changedCount++

    if (isNew) {
      billStmts.push(
        db.insert(bills).values({
          billId: entry.bill_id,
          changeHash: entry.change_hash,
          sessionId: session.sessionId,
          state: session.state,
          provider: session.provider,
          stateId: 0,
          billNumber: entry.number,
          title: entry.title ?? entry.number,
          description: entry.description ?? null,
          status: entry.status ?? 1,
          statusDate: entry.status_date ?? null,
          lastAction: entry.last_action ?? null,
          lastActionDate: entry.last_action_date ?? null,
          url: entry.url ?? null,
          stateLink: entry.state_link ?? null,
          ...(entry.bill_type ? { billType: entry.bill_type } : {}),
          createdAt: now,
          updatedAt: now,
        }).onConflictDoNothing()
      )
    }
    const changedUpdate = !isNew && billChanged
      ? db.update(bills).set({
          changeHash: entry.change_hash,
          title: entry.title ?? entry.number,
          description: entry.description ?? null,
          status: entry.status ?? 1,
          statusDate: entry.status_date ?? null,
          lastAction: entry.last_action ?? null,
          lastActionDate: entry.last_action_date ?? null,
          url: entry.url ?? null,
          ...(entry.state_link !== undefined ? { stateLink: entry.state_link } : {}),
          ...(entry.bill_type ? { billType: entry.bill_type } : {}),
          updatedAt: now,
        }).where(eq(bills.billId, entry.bill_id))
      : null

    // If the masterlist has no title for this bill, queue it for a getBill() call so we
    // can populate real metadata (title, description, sponsor, history, etc.) on first ingest.
    // Only fires when billChanged, so after the ingestor runs and updates the stored changeHash
    // this won't re-trigger on subsequent passes.
    if (billChanged && !entry.title) {
      toQueue.add(entry.bill_id)
    }

    const haystack = `${entry.title ?? ''} ${entry.description ?? ''} ${entry.number}`
    for (const t of coveringTenants) {
      const kws = keywordsByTenant.get(t.tenantId) ?? []
      const matched = kws.length > 0 ? matchesUnion(haystack, kws).matched : false
      const linkKey = `${entry.bill_id}:${t.tenantId}`
      const linkExists = existingLinks.has(linkKey)
      const prevMatchType = linkExists ? existingLinks.get(linkKey) : undefined
      const newMatchType: 'keyword' | 'manual' | null =
        prevMatchType === 'manual' ? 'manual' : (matched ? 'keyword' : null)

      if (!linkExists) {
        billTenantStmts.push(
          db.insert(billTenants).values({
            billId: entry.bill_id,
            tenantId: t.tenantId,
            matchType: newMatchType,
          }).onConflictDoNothing()
        )
      } else if ((prevMatchType ?? null) !== newMatchType) {
        billTenantStmts.push(
          db.update(billTenants).set({ matchType: newMatchType })
            .where(and(eq(billTenants.billId, entry.bill_id), eq(billTenants.tenantId, t.tenantId)))
        )
      }

      const justMatched = newMatchType !== null && (prevMatchType ?? null) !== newMatchType
      const alreadyMatchedAndChanged = newMatchType !== null && billChanged
      if (justMatched || alreadyMatchedAndChanged) {
        toQueue.add(entry.bill_id)
      }

      // Monitor-all: deliver a stubOnly metadata update for a null-linked bill when the
      // link is newly CREATED (a new non-match bill, or a tenant seeing this bill for the
      // first time) OR when an existing null-linked bill changed. Bypasses the ingestor
      // (no LegiScan call) — the tenant fetches metadata from central /bills/:id.
      const shouldStub = newMatchType === null && (!linkExists || billChanged)
      if (shouldStub) {
        const msgs = stubMessagesByTenant.get(t.tenantId) ?? []
        msgs.push({
          tenantId: t.tenantId,
          billId: toHandle(entry.bill_id),
          stubOnly: true,
        })
        stubMessagesByTenant.set(t.tenantId, msgs)
      }
    }

    if (changedUpdate && opts.deferQueuedUpdates && toQueue.has(entry.bill_id)) {
      // Still record the latest action: the ingestor's getBill-shaped record has
      // none, and detectChanges does not diff it. change_hash stays behind so a
      // failed ingest is re-queued on the next pass.
      billStmts.push(db.update(bills).set({
        lastAction: entry.last_action ?? null,
        lastActionDate: entry.last_action_date ?? null,
      }).where(eq(bills.billId, entry.bill_id)))
    } else if (changedUpdate) {
      billStmts.push(changedUpdate)
    }
  }

  for (let i = 0; i < billStmts.length; i += FLUSH_BATCH) {
    const chunk = billStmts.slice(i, i + FLUSH_BATCH) as [any, ...any[]]
    if (chunk.length > 0) await db.batch(chunk)
  }
  for (let i = 0; i < billTenantStmts.length; i += FLUSH_BATCH) {
    const chunk = billTenantStmts.slice(i, i + FLUSH_BATCH) as [any, ...any[]]
    if (chunk.length > 0) await db.batch(chunk)
  }

  const queueIds = Array.from(toQueue)
  for (let i = 0; i < queueIds.length; i += 100) {
    await ingestorQueue.sendBatch(
      queueIds.slice(i, i + 100).map<IngestorMessage>(billId => ({ billId }))
        .map(body => ({ body }))
    )
  }

  // Flush stub messages to each tenant's queue. Binding-first, HTTP fallback by queueId —
  // so tenants WITHOUT a static TENANT_QUEUE_<ID> binding (dynamically onboarded) still
  // receive monitor stubs. deliverBatchToTenant chunks at 100 internally.
  for (const [tenantId, msgs] of stubMessagesByTenant) {
    const queueId = queueIdByTenant.get(tenantId) ?? null
    const outcome = await deliverBatchToTenant(env, tenantId, queueId, msgs)
    if (outcome === 'dropped') {
      console.warn(`[sync-ls] no delivery path for tenant ${tenantId} — dropped ${msgs.length} stub messages`)
    }
  }

  await db.insert(sessionSyncLog).values({
    syncedAt: nowDb(),
    state: session.state,
    sessionId: session.sessionId,
    sessionName: session.sessionName,
    billsChecked: list.length,
    billsChanged: changedCount,
    billsQueued: queueIds.length,
  })

  console.log(
    `[sync-ls] FULL ${session.state}/${session.sessionId}: ${list.length} bills, ${queueIds.length} queued`
  )
  return queueIds
}

async function runRawPass(
  session: SessionRef & { sessionName: string; provider: string },
  coveringTenants: { tenantId: string; stateCoverage: string }[],
  provider: Provider,
  env: Env,
  db: Db,
): Promise<void> {
  void coveringTenants
  // runSync schedules a raw pass only for a provider that has listChangeHashes.
  const rawList = await provider.listChangeHashes!(session, providerContext(provider, env, db))
  if (rawList.length === 0) {
    await db.insert(sessionSyncLog).values({
      syncedAt: nowDb(),
      state: session.state,
      sessionId: session.sessionId,
      sessionName: session.sessionName,
      billsChecked: 0,
      billsChanged: 0,
      billsQueued: 0,
    })
    return
  }

  const billIds = rawList.map(e => e.bill_id)
  const existingHashes = new Map<number, string>()
  const matchedBillIds = new Set<number>()
  for (let i = 0; i < billIds.length; i += BATCH) {
    const chunk = billIds.slice(i, i + BATCH)
    const rows = await db.select({ billId: bills.billId, changeHash: bills.changeHash })
      .from(bills).where(inArray(bills.billId, chunk)).all()
    for (const r of rows) existingHashes.set(r.billId, r.changeHash)

    const matched = await db.selectDistinct({ billId: billTenants.billId })
      .from(billTenants)
      .where(and(inArray(billTenants.billId, chunk), isNotNull(billTenants.matchType)))
      .all()
    for (const m of matched) matchedBillIds.add(m.billId)
  }

  const now = nowDb()
  const billStmts: any[] = []
  const toQueue = new Set<number>()
  let changedCount = 0

  for (const entry of rawList) {
    const storedHash = existingHashes.get(entry.bill_id)
    const isNew = storedHash === undefined
    const changed = storedHash !== entry.change_hash
    if (isNew || changed) changedCount++

    if (isNew) {
      billStmts.push(
        db.insert(bills).values({
          billId: entry.bill_id,
          changeHash: '',  // sentinel: forces full update when ingestor/full-pass next sees this bill
          sessionId: session.sessionId,
          state: session.state,
          provider: session.provider,
          stateId: 0,
          billNumber: entry.number,
          title: entry.number,
          createdAt: now,
          updatedAt: now,
        }).onConflictDoNothing()
      )
    } else if (changed && matchedBillIds.has(entry.bill_id)) {
      // Only matched bills advance their change_hash on the raw pass. They get queued to the
      // ingestor, which re-pulls full data (incl. last_action) via getBill and re-writes the
      // hash itself, so the advance here is harmless.
      //
      // Unmatched (match_type=null) stubs are deliberately left with their stale hash. The raw
      // masterlist carries no last_action/status and the raw pass never notifies stub tenants,
      // so if we advanced the hash here the change would be hidden from the next full pass —
      // the only pass that refreshes stub last_action and sends stubOnly. Bumping the hash on
      // an unmatched bill therefore silently swallows the change. Leaving it stale lets the
      // full pass detect and propagate it (≤8h latency, as documented).
      billStmts.push(
        db.update(bills).set({ changeHash: entry.change_hash, updatedAt: now })
          .where(eq(bills.billId, entry.bill_id))
      )
      toQueue.add(entry.bill_id)
    }
  }

  for (let i = 0; i < billStmts.length; i += FLUSH_BATCH) {
    const chunk = billStmts.slice(i, i + FLUSH_BATCH) as [any, ...any[]]
    if (chunk.length > 0) await db.batch(chunk)
  }

  const queueIds = Array.from(toQueue)
  for (let i = 0; i < queueIds.length; i += 100) {
    await env.INGESTOR_QUEUE.sendBatch(
      queueIds.slice(i, i + 100).map<IngestorMessage>(billId => ({ billId }))
        .map(body => ({ body }))
    )
  }

  await db.insert(sessionSyncLog).values({
    syncedAt: nowDb(),
    state: session.state,
    sessionId: session.sessionId,
    sessionName: session.sessionName,
    billsChecked: rawList.length,
    billsChanged: changedCount,
    billsQueued: queueIds.length,
  })

  console.log(
    `[sync-ls] RAW ${session.state}/${session.sessionId}: ${rawList.length} bills checked, ${queueIds.length} matched+changed queued`
  )
}
