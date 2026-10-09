import { eq, and, or, inArray, notInArray, lt, gte, isNull, isNotNull, asc, sql } from 'drizzle-orm'
import { sessions, bills, billTenants, tenants, sourceRecords } from '../db/schema-legiscan'
import { decideMode, getCurrentEtHour } from '../lib/sync-schedule'
import { nowDb } from '../lib/dbTime'
import { applyMasterList } from './sync-legiscan'
import type { DirectSource, SessionRow, SourceRecord, SyncContext } from '../sources/types'
import type { LsEnv, LsDb } from '../types-legiscan'

/**
 * The sync for every direct source (src/sources), run on central's hourly cron
 * alongside the LegiScan sync, one job per source.
 *
 * None of the sources so far has a modified-since filter, so each full pass
 * takes the source's snapshot of a session, stores every record whose hash
 * changed, and feeds the whole list to the same applyMasterList the LegiScan
 * full pass uses: keyword matching, monitor stubs, and queueing matched and
 * changed bills. The ingestor then asks the source to build each bill.
 */

const BATCH = 80
const FLUSH_BATCH = 200

export interface SourcePassReport { sessionId: number; sessionName: string; records: number; queued: number; refreshed: number }

type Covering = { tenantId: string; stateCoverage: string; queueId: string | null }

/**
 * `force` (the admin "run now" route) ignores the hour of day: the source
 * refreshes its sessions and every synced session gets a full pass.
 */
export async function runSourceSync(
  source: DirectSource, env: LsEnv, db: LsDb, opts: { force?: boolean } = {},
): Promise<SourcePassReport[]> {
  if (!source.enabled(env)) return []

  const active = await db.select().from(tenants).where(eq(tenants.active, true)).all()
  const coveringByState = new Map<string, Covering[]>()
  for (const state of source.states) {
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

  const ctx: SyncContext = { today: nowDb().slice(0, 10), etHour: getCurrentEtHour(), force: !!opts.force }
  const toSync = await source.syncSessions(env, db, ctx)

  // Moving a state from LegiScan to a direct source needs a cutover that moves
  // tenant links onto the new rows (cron/cutover.ts). Until one has run, refuse:
  // syncing anyway would give every bill in the state a second copy under a new
  // id, and tenants would see (and pay AI for) both. Only sessions the source
  // syncs count; earlier LegiScan sessions stay as they are.
  const states = [...coveringByState.keys()]
  const legacy = await legacyLinks(db, states, toSync)
  if (legacy.length > 0) {
    throw new Error(
      `[sync-${source.id}] ${legacy.length} LegiScan bill links exist in ${states.join(', ')}; ` +
      `the ${source.id} sync is paused until they are cut over (POST /api/admin/sources/${source.id}/cutover). ` +
      'These states are not syncing from either source meanwhile.')
  }

  const reports: SourcePassReport[] = []
  for (const session of toSync) {
    const covering = coveringByState.get(session.state)
    if (!covering) continue
    // A snapshot is the only kind of pull, so only the session's full-pass hours run it.
    if (!ctx.force && decideMode(session, ctx.etHour) !== 'full') continue
    console.log(`[sync-${source.id}] full pass: ${session.sessionName}`)
    const counts = await runSourcePass(source, session, covering, env, db, ctx)
    reports.push({ sessionId: session.sessionId, sessionName: session.sessionName, ...counts })
    await db.update(sessions).set({ lastSyncedAt: nowDb() }).where(eq(sessions.sessionId, session.sessionId))
  }
  return reports
}

async function runSourcePass(
  source: DirectSource,
  session: SessionRow,
  covering: Covering[],
  env: LsEnv,
  db: LsDb,
  ctx: SyncContext,
): Promise<{ records: number; queued: number; refreshed: number }> {
  const records = await source.snapshot(session, env, db, ctx)
  if (records.length === 0) return { records: 0, queued: 0, refreshed: 0 }

  const entries = await storeRecords(source, session, records, db, ctx)
  const queue = sourceQueue(source, env)
  const queued = new Set(await applyMasterList(session, entries, covering, env, db, queue,
    { deferQueuedUpdates: true }))

  const refreshed = source.detailsRefresh
    ? await refreshStaleDetails(source.detailsRefresh, session.sessionId, queued, queue, db)
    : 0
  if (refreshed > 0) console.log(`[sync-${source.id}] refreshing details for ${refreshed} tracked bills`)
  return { records: records.length, queued: queued.size, refreshed }
}

export interface LegacyLink {
  billId: number
  number: string
  tenantId: string
  matchType: string | null
  yearStart: number
  special: number
  sessionName: string
}

/**
 * Tenant links to LegiScan bills in these states, in sessions that end no
 * earlier than the first year of the direct-source sessions given: the bills a
 * direct source's own rows would duplicate.
 */
export async function legacyLinks(db: LsDb, states: string[], directSessions: SessionRow[]): Promise<LegacyLink[]> {
  if (states.length === 0 || directSessions.length === 0) return []
  const fromYear = Math.min(...directSessions.map(s => s.yearStart))
  return db.select({
    billId: bills.billId, number: bills.billNumber, tenantId: billTenants.tenantId, matchType: billTenants.matchType,
    yearStart: sessions.yearStart, special: sessions.special, sessionName: sessions.sessionName,
  })
    .from(billTenants)
    .innerJoin(bills, eq(bills.billId, billTenants.billId))
    // A bill whose session row is missing counts: nothing says it is from an earlier session.
    .leftJoin(sessions, eq(sessions.sessionId, bills.sessionId))
    .where(and(inArray(bills.state, states), eq(bills.source, 'legiscan'),
      or(isNull(sessions.sessionId), gte(sessions.yearEnd, fromYear))))
    .all()
    .then(rows => rows.map(r => ({ ...r, yearStart: r.yearStart ?? 0, special: r.special ?? 0, sessionName: r.sessionName ?? '' })))
}

export function sourceQueue(source: DirectSource, env: LsEnv): Queue {
  return source.ingestQueue?.(env) ?? env.INGESTOR_QUEUE
}

/**
 * Store each record whose hash changed in source_records, and return the
 * masterlist entries for all of them.
 */
export async function storeRecords(
  source: DirectSource, session: SessionRow, records: SourceRecord[], db: LsDb, ctx: SyncContext,
) {
  // Stored hashes (to skip unchanged records) and stored descriptions (a list
  // record may have none; the ingestor fills them, and the pass would
  // otherwise overwrite them with null on the next change).
  const ids = records.map(r => r.billId)
  const storedHash = new Map<number, string>()
  const storedDesc = new Map<number, string | null>()
  for (let i = 0; i < ids.length; i += BATCH) {
    const chunk = ids.slice(i, i + BATCH)
    for (const r of await db.select({ billId: sourceRecords.billId, rawHash: sourceRecords.rawHash })
      .from(sourceRecords).where(inArray(sourceRecords.billId, chunk)).all()) storedHash.set(r.billId, r.rawHash)
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
        source: source.id,
        nativeKey: record.nativeKey,
        sessionId: session.sessionId,
        rawJson: JSON.stringify(record.raw),
        rawHash: record.hash,
        updatedAt: now,
      }
      const { billId: _id, ...update } = values
      stmts.push(db.insert(sourceRecords).values(values).onConflictDoUpdate({ target: sourceRecords.billId, set: update }))
    }
    entries.push(await source.toEntry(record, { description: storedDesc.get(record.billId) ?? null }, ctx))
  }
  for (let i = 0; i < stmts.length; i += FLUSH_BATCH) {
    const chunk = stmts.slice(i, i + FLUSH_BATCH) as [any, ...any[]]
    if (chunk.length > 0) await db.batch(chunk)
  }
  return entries
}

/** Re-queue tracked, unsettled bills whose details are stale. */
async function refreshStaleDetails(
  cfg: NonNullable<DirectSource['detailsRefresh']>,
  sessionId: number,
  queued: Set<number>,
  queue: Queue,
  db: LsDb,
): Promise<number> {
  const stale = await db.selectDistinct({ billId: sourceRecords.billId, fetchedAt: sourceRecords.detailsFetchedAt })
    .from(sourceRecords)
    .innerJoin(billTenants, eq(billTenants.billId, sourceRecords.billId))
    .innerJoin(bills, eq(bills.billId, sourceRecords.billId))
    .where(and(
      eq(sourceRecords.sessionId, sessionId),
      isNotNull(billTenants.matchType),
      notInArray(bills.status, cfg.settledStatuses),
      or(isNull(sourceRecords.detailsFetchedAt), lt(sourceRecords.detailsFetchedAt, sql`datetime('now', ${cfg.maxAge})`)),
    ))
    .orderBy(asc(sourceRecords.detailsFetchedAt))
    .limit(cfg.perPass + queued.size)
    .all()
  const refresh = stale.map(r => r.billId).filter(id => !queued.has(id)).slice(0, cfg.perPass)
  for (let i = 0; i < refresh.length; i += 100) {
    await queue.sendBatch(refresh.slice(i, i + 100).map(billId => ({ body: { billId } })))
  }
  return refresh.length
}
