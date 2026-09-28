import { eq, and, inArray, gte, lt } from 'drizzle-orm'
import { getBulkData, getCouncilPeriods, getMembers, type LimsBulkRecord, type LimsCouncilPeriod } from '../lib/lims'
import { bulkHash, clean, councilPeriodName, DC_STATE_ID, LIMS_STATE, toMasterListEntry } from '../lib/lims-map'
import { limsBillId, limsPeopleId, limsSessionId, LIMS_SESSION_ID_BASE } from '../lib/lims-ids'
import { limsCategories, limsStates } from '../lib/lims-config'
import { decideMode, getCurrentEtHour } from '../lib/sync-schedule'
import { sessions, bills, tenants, people, limsRecords } from '../db/schema-legiscan'
import { trackLimsCall } from '../lib/lims-ingest'
import { nowDb } from '../lib/dbTime'
import { applyMasterList } from './sync-legiscan'
import type { LsEnv, LsDb } from '../types-legiscan'

/**
 * DC Council LIMS sync. Runs on central's hourly cron alongside the LegiScan
 * sync, and does nothing unless LIMS_API_KEY is set and LIMS_STATES includes DC
 * (in which case the LegiScan sync leaves DC alone).
 *
 * Each full pass pulls BulkData for the configured categories of the current
 * Council Period (one call per category), stores each record, and feeds the
 * list to the same applyMasterList the LegiScan full pass uses: keyword
 * matching, monitor stubs, and queueing matched-and-changed bills. The
 * ingestor then adds LegislationDetails for those bills (lib/lims-map.ts).
 *
 * LIMS has no modified-since filter; BulkData is a daily snapshot, so a
 * record-hash comparison is the change signal.
 */

const BATCH = 80
const FLUSH_BATCH = 200
const MEMBER_BIO_URL = 'https://dccouncil.gov/councilmembers/'

export async function runLimsSync(env: LsEnv, db: LsDb): Promise<void> {
  if (!limsStates(env).has(LIMS_STATE) || !env.LIMS_API_KEY) return

  const covering = (await db.select().from(tenants).where(eq(tenants.active, true)).all())
    .filter(t => {
      try {
        const cov = JSON.parse(t.stateCoverage) as string[]
        return cov.includes('*') || cov.includes(LIMS_STATE)
      } catch { return false }
    })
    .map(t => ({ tenantId: t.tenantId, stateCoverage: t.stateCoverage, queueId: t.queueId ?? null }))
  if (covering.length === 0) return

  const etHour = getCurrentEtHour()
  const today = nowDb().slice(0, 10)

  let current = await currentLimsSession(db, today)
  // Council Periods and members change every two years; refresh daily, or now if
  // this central has never seen a LIMS session.
  if (etHour === 5 || !current) {
    await refreshCouncilPeriod(env.LIMS_API_KEY, db, today)
    current = await currentLimsSession(db, today)
  }
  if (!current) {
    console.warn('[sync-lims] no current Council Period; skipping')
    return
  }

  // LIMS has one kind of pull, so only the session's full-pass hours run it.
  if (decideMode(current, etHour) !== 'full') return

  console.log(`[sync-lims] full pass: ${current.sessionName}`)
  await runLimsPass(current, covering, env, db, today)
  await db.update(sessions).set({ lastSyncedAt: nowDb() }).where(eq(sessions.sessionId, current.sessionId))
}

async function currentLimsSession(db: LsDb, today: string) {
  const rows = await db.select().from(sessions).where(and(
    eq(sessions.state, LIMS_STATE),
    gte(sessions.sessionId, LIMS_SESSION_ID_BASE),
    lt(sessions.sessionId, LIMS_SESSION_ID_BASE * 2),
  )).all()
  const year = Number(today.slice(0, 4))
  return rows.find(r => r.prior === 0 && r.yearStart <= year && year <= r.yearEnd)
    ?? rows.find(r => r.prior === 0)
    ?? null
}

function pickCurrentPeriod(periods: LimsCouncilPeriod[], today: string): LimsCouncilPeriod | null {
  const inRange = periods.find(p => p.startDate.slice(0, 10) <= today && today <= p.endDate.slice(0, 10))
  return inRange ?? [...periods].sort((a, b) => b.councilPeriodId - a.councilPeriodId)[0] ?? null
}

/** Upsert the current Council Period as a session, and its Councilmembers as people. */
export async function refreshCouncilPeriod(apiKey: string, db: LsDb, today: string): Promise<void> {
  const periods = await getCouncilPeriods(apiKey, () => trackLimsCall(db, 'CouncilPeriods', {}))
  const cp = pickCurrentPeriod(periods, today)
  if (!cp) return

  const sessionId = limsSessionId(cp.councilPeriodId)
  const name = councilPeriodName(cp)
  // Any other LIMS session stops being current.
  await db.update(sessions).set({ prior: 1 }).where(and(
    gte(sessions.sessionId, LIMS_SESSION_ID_BASE),
    lt(sessions.sessionId, LIMS_SESSION_ID_BASE * 2),
  ))
  await db.insert(sessions).values({
    sessionId,
    state: LIMS_STATE,
    stateId: DC_STATE_ID,
    yearStart: Number(cp.startDate.slice(0, 4)),
    yearEnd: Number(cp.endDate.slice(0, 4)),
    sessionTag: `CP${cp.councilPeriodId}`,
    sessionTitle: name,
    sessionName: name,
    prior: 0,
    sineDie: 0,
  }).onConflictDoUpdate({
    target: sessions.sessionId,
    set: { sessionTitle: name, sessionName: name, prior: 0 },
  })

  const members = await getMembers(cp.councilPeriodId, apiKey,
    () => trackLimsCall(db, 'Members', { councilPeriodId: cp.councilPeriodId }))
  for (const m of members) {
    const values = {
      peopleId: limsPeopleId(m.id),
      stateId: DC_STATE_ID,
      role: clean(m.title) || 'Councilmember',
      name: clean(m.name),
      firstName: clean(m.firstName) || null,
      middleName: clean(m.middleName) || null,
      lastName: clean(m.lastName) || null,
      // bills-legiscan builds a legiscan.com profile link for any sponsor with a
      // people id and no biography URL; LIMS people have no LegiScan profile.
      bioJson: JSON.stringify({ social: { biography: MEMBER_BIO_URL } }),
    }
    const { peopleId: _id, ...update } = values
    await db.insert(people).values(values).onConflictDoUpdate({ target: people.peopleId, set: update })
  }
}

async function runLimsPass(
  session: { sessionId: number; state: string; sessionName: string },
  coveringTenants: { tenantId: string; stateCoverage: string; queueId: string | null }[],
  env: LsEnv,
  db: LsDb,
  today: string,
): Promise<void> {
  const councilPeriodId = session.sessionId - LIMS_SESSION_ID_BASE

  // One call per category, serially: LIMS rejects concurrent bursts.
  const records: { rec: LimsBulkRecord; categoryId: number; billId: number }[] = []
  for (const categoryId of limsCategories(env)) {
    const rows = await getBulkData(categoryId, councilPeriodId, env.LIMS_API_KEY!,
      () => trackLimsCall(db, 'BulkData', { categoryId, councilPeriodId }))
    for (const rec of rows) {
      const billId = limsBillId(rec.legislationNumber)
      if (billId === null) {
        console.warn(`[sync-lims] skipping unrecognised measure number "${rec.legislationNumber}"`)
        continue
      }
      records.push({ rec, categoryId, billId })
    }
  }
  if (records.length === 0) return

  // Stored hashes (to skip unchanged records) and stored descriptions (bulk has
  // none; the ingestor fills them from LegislationDetails, and the full pass
  // would otherwise overwrite them with null on the next change).
  const ids = records.map(r => r.billId)
  const storedHash = new Map<number, string>()
  const storedDesc = new Map<number, string | null>()
  for (let i = 0; i < ids.length; i += BATCH) {
    const chunk = ids.slice(i, i + BATCH)
    for (const r of await db.select({ billId: limsRecords.billId, bulkHash: limsRecords.bulkHash })
      .from(limsRecords).where(inArray(limsRecords.billId, chunk)).all()) storedHash.set(r.billId, r.bulkHash)
    for (const r of await db.select({ billId: bills.billId, description: bills.description })
      .from(bills).where(inArray(bills.billId, chunk)).all()) storedDesc.set(r.billId, r.description)
  }

  const now = nowDb()
  const stmts: any[] = []
  const entries = []
  for (const { rec, categoryId, billId } of records) {
    const hash = await bulkHash(rec)
    if (storedHash.get(billId) !== hash) {
      const values = {
        billId,
        legislationNumber: clean(rec.legislationNumber),
        councilPeriodId,
        categoryId,
        bulkJson: JSON.stringify(rec),
        bulkHash: hash,
        updatedAt: now,
      }
      const { billId: _id, ...update } = values
      stmts.push(db.insert(limsRecords).values(values).onConflictDoUpdate({ target: limsRecords.billId, set: update }))
    }
    entries.push(toMasterListEntry(rec, billId, hash, storedDesc.get(billId) ?? null, today))
  }
  for (let i = 0; i < stmts.length; i += FLUSH_BATCH) {
    const chunk = stmts.slice(i, i + FLUSH_BATCH) as [any, ...any[]]
    if (chunk.length > 0) await db.batch(chunk)
  }

  await applyMasterList(session, entries, coveringTenants, env, db, env.LIMS_INGESTOR_QUEUE ?? env.INGESTOR_QUEUE)
}
