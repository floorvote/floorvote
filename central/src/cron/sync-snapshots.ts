import { eq, and, or, inArray, notInArray, lt, isNull, isNotNull, asc, sql } from 'drizzle-orm'
import { sessions, bills, billTenants, tenants, people, providerRecords } from '../db/schema'
import { decideMode, getCurrentEtHour } from '../lib/sync-schedule'
import { nowDb } from '../lib/dbTime'
import { providerContext } from '../lib/providerContext'
import { ingestQueueFor, providerConfigured } from '../lib/providerRouting'
import { loadStateOwners, statesOwnedBy } from '../lib/stateProviders'
import { applyMasterList } from './sync'
import { assignSessionSlugs } from '../lib/sessionSlugs'
import type { Provider, ProviderContext, ProviderPerson, ProviderRecord, StoredSession, SyncSession } from '../providers'
import type { Env, Db } from '../types'

/**
 * The sync for every snapshot provider (Provider.snapshot), run on central's
 * hourly cron alongside the LegiScan sync, one job per provider, for the
 * states the ownership table gives it (lib/stateProviders.ts).
 *
 * None of these providers has a modified-since filter, so each full pass
 * takes the provider's snapshot of a session, stores every record whose hash
 * changed, and feeds the whole list to the same applyMasterList the LegiScan
 * full pass uses: keyword matching, monitor stubs, and queueing matched and
 * changed bills. The ingestor then hands each stored record back to the
 * provider's fetchMeasure.
 */

const BATCH = 80
const FLUSH_BATCH = 200

export interface SnapshotPassReport { sessionId: number; sessionName: string; records: number; queued: number; refreshed: number }

type Covering = { tenantId: string; stateCoverage: string; queueId: string | null }
type SessionRow = typeof sessions.$inferSelect

/** A provider with everything the snapshot sync calls. */
export type SnapshotProvider = Provider & Required<Pick<Provider, 'states' | 'selectSessions' | 'snapshot' | 'toEntry'>>

export function isSnapshotProvider(provider: Provider | undefined): provider is SnapshotProvider {
  return !!provider?.states && !!provider.selectSessions && !!provider.snapshot && !!provider.toEntry
}

/**
 * `force` (the admin "run now" route) ignores the hour of day: the provider
 * refreshes its sessions and every synced session gets a full pass.
 */
export async function runSnapshotSync(
  provider: Provider, env: Env, db: Db, opts: { force?: boolean } = {},
): Promise<SnapshotPassReport[]> {
  if (!isSnapshotProvider(provider)) return []
  const owned = statesOwnedBy(await loadStateOwners(env, db), provider.id)
  if (owned.length === 0) return []
  if (!providerConfigured(provider, env)) {
    console.warn(`[sync-${provider.id}] owns ${owned.join(', ')} but isn't configured on this central (missing its API key?); not syncing`)
    return []
  }

  const active = await db.select().from(tenants).where(eq(tenants.active, true)).all()
  const coveringByState = new Map<string, Covering[]>()
  for (const state of owned) {
    const covering = active
      .filter(t => {
        try {
          const cov = JSON.parse(t.stateCoverage) as string[]
          return cov.includes('*') || cov.includes(state)
        } catch { return false }
      })
      .map(t => ({ tenantId: t.tenantId, stateCoverage: t.stateCoverage, queueId: t.queueId ?? null }))
    if (covering.length > 0) coveringByState.set(state, covering)
  }
  if (coveringByState.size === 0) return []

  const ctx = providerContext(provider, env, db)
  const etHour = getCurrentEtHour()
  const force = !!opts.force
  const toSync: SessionRow[] = []
  for (const state of owned) toSync.push(...await sessionsToSync(provider, state, ctx, etHour, force, db))

  const reports: SnapshotPassReport[] = []
  for (const session of toSync) {
    const covering = coveringByState.get(session.state)
    if (!covering) continue
    // A snapshot is the only kind of pull, so only the session's full-pass hours run it.
    if (!force && decideMode(session, etHour) !== 'full') continue
    console.log(`[sync-${provider.id}] full pass: ${session.sessionName}`)
    const counts = await runSnapshotPass(provider, session, covering, env, db, ctx)
    reports.push({ sessionId: session.sessionId, sessionName: session.sessionName, ...counts })
    await db.update(sessions).set({ lastSyncedAt: nowDb() }).where(eq(sessions.sessionId, session.sessionId))
  }
  return reports
}

/**
 * The provider's sessions for a state that are due a pass, after refreshing
 * them when that is due: at 5 ET each day (sessions change a few times a year
 * at most), on a forced run, or whenever none would sync, which is also how a
 * provider's first sessions arrive.
 */
async function sessionsToSync(
  provider: SnapshotProvider, state: string, ctx: ProviderContext, etHour: number, force: boolean, db: Db,
): Promise<SessionRow[]> {
  const stored = await providerSessions(db, provider.id, state)
  const due = provider.selectSessions(stored, ctx.today)
  if (!force && etHour !== 5 && due.length > 0) return due

  await refreshProviderSessions(provider, state, ctx, db)
  const refreshed = provider.selectSessions(await providerSessions(db, provider.id, state), ctx.today)
  if (refreshed.length === 0) console.warn(`[sync-${provider.id}] no current session for ${state}; skipping`)
  return refreshed
}

async function providerSessions(db: Db, providerId: string, state: string): Promise<SessionRow[]> {
  return db.select().from(sessions).where(and(eq(sessions.state, state), eq(sessions.provider, providerId))).all()
}

function storedSession(row: SessionRow): StoredSession {
  return {
    sessionId: row.sessionId, state: row.state, sessionTag: row.sessionTag,
    yearStart: row.yearStart, yearEnd: row.yearEnd, sessionName: row.sessionName, prior: row.prior,
  }
}

/** The `sessions` row for a session a provider listed. */
function sessionValues(providerId: string, state: string, s: SyncSession) {
  return {
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
    provider:     providerId,
  }
}

/**
 * Upsert the sessions the provider lists for a state, with whether each has
 * adjourned sine die. Any other session of the provider's has ended: it stops
 * being current and is marked sine die, unless the provider listed none (a
 * failed or empty answer changes nothing). Then the provider's people are
 * refreshed, for the sessions just listed and every other one central holds
 * its measures in.
 */
export async function refreshProviderSessions(provider: Provider, state: string, ctx: ProviderContext, db: Db): Promise<void> {
  const listed = await provider.listSessions(state, ctx)
  if (listed.length === 0) return
  for (const s of listed) {
    const values = sessionValues(provider.id, state, s)
    await db.insert(sessions).values(values).onConflictDoUpdate({
      target: sessions.sessionId,
      set: { sessionTitle: values.sessionTitle, sessionName: values.sessionName, prior: values.prior, sineDie: values.sineDie },
    })
  }
  const listedIds = listed.map(s => s.session_id)
  await db.update(sessions).set({ prior: 1, sineDie: 1 })
    .where(and(eq(sessions.provider, provider.id), eq(sessions.state, state), notInArray(sessions.sessionId, listedIds)))
  await assignSessionSlugs(db)

  if (!provider.listPeople) return
  const holding = (await db.selectDistinct({ id: providerRecords.sessionId }).from(providerRecords)
    .where(eq(providerRecords.provider, provider.id)).all()).map(r => r.id)
  const ids = [...new Set([...listedIds, ...holding])]
  const rows: SessionRow[] = []
  for (let i = 0; i < ids.length; i += BATCH) {
    rows.push(...await db.select().from(sessions)
      .where(and(eq(sessions.provider, provider.id), inArray(sessions.sessionId, ids.slice(i, i + BATCH)))).all())
  }
  await upsertProviderPeople(db, provider.id, await provider.listPeople(rows.map(storedSession), ctx))
}

/**
 * Upsert a provider's people, under its id. Only the fields a person carries
 * are written, so a row keeps what the provider doesn't list (such as a
 * party the ingest stored from a sponsor record).
 */
async function upsertProviderPeople(db: Db, providerId: string, list: ProviderPerson[]): Promise<void> {
  const stmts = list.map(p => {
    const values = {
      peopleId: p.people_id,
      name: p.name,
      ...(p.state_id !== undefined ? { stateId: p.state_id } : {}),
      ...(p.role !== undefined ? { role: p.role } : {}),
      ...(p.role_id !== undefined ? { roleId: p.role_id } : {}),
      ...(p.first_name !== undefined ? { firstName: p.first_name } : {}),
      ...(p.middle_name !== undefined ? { middleName: p.middle_name } : {}),
      ...(p.last_name !== undefined ? { lastName: p.last_name } : {}),
      ...(p.bio !== undefined ? { bioJson: JSON.stringify(p.bio) } : {}),
      provider: providerId,
    }
    const { peopleId: _id, ...update } = values
    return db.insert(people).values(values).onConflictDoUpdate({ target: people.peopleId, set: update })
  })
  if (stmts.length > 0) await db.batch(stmts as [typeof stmts[0], ...typeof stmts])
}

async function runSnapshotPass(
  provider: SnapshotProvider,
  session: SessionRow,
  covering: Covering[],
  env: Env,
  db: Db,
  ctx: ProviderContext,
): Promise<{ records: number; queued: number; refreshed: number }> {
  const { records, people: listedPeople } = await provider.snapshot(storedSession(session), ctx)
  if (listedPeople && listedPeople.length > 0) await upsertProviderPeople(db, provider.id, listedPeople)
  if (records.length === 0) return { records: 0, queued: 0, refreshed: 0 }

  const entries = await storeRecords(provider, session, records, db, ctx)
  const queue = ingestQueueFor(provider, env)
  const queued = new Set(await applyMasterList(session, entries, covering, env, db, queue,
    { deferQueuedUpdates: true }))

  const refreshed = provider.detailsRefresh
    ? await refreshStaleDetails(provider.detailsRefresh, session.sessionId, queued, queue, db)
    : 0
  if (refreshed > 0) console.log(`[sync-${provider.id}] refreshing details for ${refreshed} tracked bills`)
  return { records: records.length, queued: queued.size, refreshed }
}

/**
 * Store each record whose hash changed in provider_records, and return the
 * full-pass entries for all of them.
 */
async function storeRecords(
  provider: SnapshotProvider, session: SessionRow, records: ProviderRecord[], db: Db, ctx: ProviderContext,
) {
  // Stored hashes (to skip unchanged records) and stored descriptions (a list
  // record may have none; the ingestor fills them, and the pass would
  // otherwise overwrite them with null on the next change).
  const ids = records.map(r => r.billId)
  const storedHash = new Map<number, string>()
  const storedDesc = new Map<number, string | null>()
  for (let i = 0; i < ids.length; i += BATCH) {
    const chunk = ids.slice(i, i + BATCH)
    for (const r of await db.select({ billId: providerRecords.billId, rawHash: providerRecords.rawHash })
      .from(providerRecords).where(inArray(providerRecords.billId, chunk)).all()) storedHash.set(r.billId, r.rawHash)
    for (const r of await db.select({ billId: bills.billId, description: bills.description })
      .from(bills).where(inArray(bills.billId, chunk)).all()) storedDesc.set(r.billId, r.description)
  }

  const now = nowDb()
  const stmts: any[] = []
  const entries = []
  for (const record of records) {
    if (storedHash.get(record.billId) !== record.hash) {
      const values = {
        billId: record.billId,
        provider: provider.id,
        nativeKey: record.nativeKey,
        sessionId: session.sessionId,
        rawJson: JSON.stringify(record.raw),
        rawHash: record.hash,
        updatedAt: now,
      }
      const { billId: _id, ...update } = values
      stmts.push(db.insert(providerRecords).values(values).onConflictDoUpdate({ target: providerRecords.billId, set: update }))
    }
    entries.push(await provider.toEntry(record, { description: storedDesc.get(record.billId) ?? null }, ctx))
  }
  for (let i = 0; i < stmts.length; i += FLUSH_BATCH) {
    const chunk = stmts.slice(i, i + FLUSH_BATCH) as [any, ...any[]]
    if (chunk.length > 0) await db.batch(chunk)
  }
  return entries
}

/** Re-queue tracked, unsettled bills whose details are stale. */
async function refreshStaleDetails(
  cfg: NonNullable<Provider['detailsRefresh']>,
  sessionId: number,
  queued: Set<number>,
  queue: Queue,
  db: Db,
): Promise<number> {
  const stale = await db.selectDistinct({ billId: providerRecords.billId, fetchedAt: providerRecords.detailsFetchedAt })
    .from(providerRecords)
    .innerJoin(billTenants, eq(billTenants.billId, providerRecords.billId))
    .innerJoin(bills, eq(bills.billId, providerRecords.billId))
    .where(and(
      eq(providerRecords.sessionId, sessionId),
      isNotNull(billTenants.matchType),
      notInArray(bills.status, [...cfg.settledStatuses]),
      or(isNull(providerRecords.detailsFetchedAt), lt(providerRecords.detailsFetchedAt, sql`datetime('now', ${cfg.maxAge})`)),
    ))
    .orderBy(asc(providerRecords.detailsFetchedAt))
    .limit(cfg.perPass + queued.size)
    .all()
  const refresh = stale.map(r => r.billId).filter(id => !queued.has(id)).slice(0, cfg.perPass)
  for (let i = 0; i < refresh.length; i += 100) {
    await queue.sendBatch(refresh.slice(i, i + 100).map(billId => ({ body: { billId } })))
  }
  return refresh.length
}

export interface ImportReport {
  imported: string[]
  notFound: string[]
  invalid: string[]
}

/**
 * Import specific measures from a provider, from any session, for one tenant,
 * and track them there as manual picks, so each gets a full ingest and AI
 * analysis whatever the tenant's keywords. A session central has never seen
 * is created as the provider lists it. Behind POST /admin/lims-import.
 */
export async function importProviderMeasures(
  provider: Provider, env: Env, db: Db, tenantId: string, numbers: string[],
): Promise<ImportReport> {
  if (!isSnapshotProvider(provider) || !provider.importMeasures) throw new Error(`${provider.id} can't import measures`)
  const tenant = await db.select().from(tenants).where(eq(tenants.tenantId, tenantId)).get()
  if (!tenant) throw new Error(`tenant ${tenantId} not found`)

  const ctx = providerContext(provider, env, db)
  const found = await provider.importMeasures(numbers, ctx)
  // Owners seeded before any session is slugged: the plain slug goes to the owner's session.
  await loadStateOwners(env, db)
  const result: ImportReport = { imported: [], notFound: found.notFound, invalid: found.invalid }
  const queue = ingestQueueFor(provider, env)
  const covering = [{ tenantId, stateCoverage: tenant.stateCoverage, queueId: tenant.queueId ?? null }]

  for (const { state, session: listed, records, numbers: imported } of found.sessions) {
    // An existing row is left alone, so importing from the current session changes nothing.
    await db.insert(sessions).values(sessionValues(provider.id, state, listed)).onConflictDoNothing()
    await assignSessionSlugs(db)
    const session = await db.select().from(sessions).where(eq(sessions.sessionId, listed.session_id)).get()
    if (!session) throw new Error(`[${provider.id}-import] session ${listed.session_name} was not written`)
    if (records.length === 0) continue

    const entries = await storeRecords(provider, session, records, db, ctx)
    const ids = records.map(r => r.billId)
    const queued = new Set(await applyMasterList(session, entries, covering, env, db, queue, { deferQueuedUpdates: true }))
    for (const billId of ids) {
      await db.insert(billTenants).values({ billId, tenantId, matchType: 'manual' })
        .onConflictDoUpdate({ target: [billTenants.billId, billTenants.tenantId], set: { matchType: 'manual' } })
    }
    const toQueue = ids.filter(id => !queued.has(id))
    for (let i = 0; i < toQueue.length; i += 100) {
      await queue.sendBatch(toQueue.slice(i, i + 100).map(billId => ({ body: { billId, interactive: true } })))
    }
    result.imported.push(...imported)
  }
  return result
}
