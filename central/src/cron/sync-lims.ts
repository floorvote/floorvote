import { eq, and, or, inArray, notInArray, gte, lt, isNull, isNotNull, asc, sql } from 'drizzle-orm'
import { getBulkData, getCouncilPeriods, getMembers, type LimsBulkRecord, type LimsCouncilPeriod } from '../lib/lims'
import { bulkHash, clean, councilPeriodName, DC_STATE_ID, effectiveChangeHash, LIMS_STATE, limsStatusCode, sha256Hex, toMasterListEntry } from '../lib/lims-map'
import { getHearingsCalendar } from '../lib/lims-hearings'
import { limsBillId, limsPeopleId, limsSessionId, LIMS_BILL_ID_BASE, LIMS_SESSION_ID_BASE } from '../lib/lims-ids'
import { limsCategories, limsStates } from '../lib/lims-config'
import { decideMode, getCurrentEtHour } from '../lib/sync-schedule'
import { sessions, bills, billTenants, tenants, people, limsRecords, councilEvents } from '../db/schema-legiscan'
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

/**
 * LegislationDetails can change while the bulk record does not: a committee
 * report is filed after its mark-up, a vote is recorded, a hearing is
 * cancelled. So tracked bills get their details re-fetched when they are older
 * than this, a bounded number per pass. With three passes a day that is at most
 * 150 extra LIMS calls a day.
 */
const DETAILS_MAX_AGE = '-2 days'
const DETAILS_REFRESH_PER_PASS = 50
/** Final statuses: nothing further arrives in LegislationDetails. */
const SETTLED_STATUSES = ['Official Law', 'Withdrawn', 'Failed', 'Disapproved', 'Deemed Disapproved', 'Expired', 'Approved', 'Deemed Approved']
  .map(limsStatusCode)
  .concat(limsStatusCode(''))  // oversight notices: details add nothing
const MEMBER_BIO_URL = 'https://dccouncil.gov/councilmembers/'

export interface LimsPassReport { sessionId: number; sessionName: string; records: number; queued: number; refreshed: number }

/**
 * `force` (the admin "run now" route) ignores the hour of day: it refreshes the
 * Council Period and members and runs a full pass on every synced session.
 */
export async function runLimsSync(env: LsEnv, db: LsDb, opts: { force?: boolean } = {}): Promise<LimsPassReport[]> {
  if (!limsStates(env).has(LIMS_STATE) || !env.LIMS_API_KEY) return []

  const covering = (await db.select().from(tenants).where(eq(tenants.active, true)).all())
    .filter(t => {
      try {
        const cov = JSON.parse(t.stateCoverage) as string[]
        return cov.includes('*') || cov.includes(LIMS_STATE)
      } catch { return false }
    })
    .map(t => ({ tenantId: t.tenantId, stateCoverage: t.stateCoverage, queueId: t.queueId ?? null }))
  if (covering.length === 0) return []

  // Switching an existing deployment from LegiScan to LIMS needs a cutover that
  // moves tenant links onto the LIMS rows. Until one has run, refuse: syncing
  // anyway would give every DC bill a second copy under a new id, and tenants
  // would see (and pay AI for) both.
  const legacy = await db.select({ n: sql<number>`COUNT(*)` })
    .from(bills)
    .innerJoin(billTenants, eq(billTenants.billId, bills.billId))
    .where(and(eq(bills.state, LIMS_STATE), lt(bills.billId, LIMS_BILL_ID_BASE)))
    .get()
  if (Number(legacy?.n ?? 0) > 0) {
    throw new Error(
      `[sync-lims] ${legacy!.n} LegiScan DC bill links exist; LIMS sync is paused until they are cut over. ` +
      'DC is not syncing from either source meanwhile.')
  }

  const etHour = getCurrentEtHour()
  const today = nowDb().slice(0, 10)

  let current = await currentLimsSession(db, today)
  // Council Periods and members change every two years; refresh daily, or now if
  // this central has never seen a LIMS session.
  if (opts.force || etHour === 5 || !current) {
    await refreshCouncilPeriod(env.LIMS_API_KEY, db, today)
    current = await currentLimsSession(db, today)
  }
  if (!current) {
    console.warn('[sync-lims] no current Council Period; skipping')
    return []
  }

  // The previous Council Period keeps syncing for a year after it ends: acts
  // passed late in a period finish Mayoral and Congressional review after it.
  const year = Number(today.slice(0, 4))
  const toSync = [current, ...(await limsSessionRows(db)).filter(r => r.prior === 1 && r.yearEnd >= year - 1)]

  const reports: LimsPassReport[] = []
  // The Council's hearing calendar rides along with each full pass (and the
  // forced one): five small requests covering last month through three ahead.
  const anyFull = opts.force || toSync.some(session => decideMode(session, etHour) === 'full')
  if (anyFull) {
    try {
      await syncCouncilCalendar(db, today)
    } catch (err) {
      console.error('[sync-lims] council calendar sync failed:', err)
    }
  }
  for (const session of toSync) {
    // LIMS has one kind of pull, so only the session's full-pass hours run it.
    if (!opts.force && decideMode(session, etHour) !== 'full') continue
    console.log(`[sync-lims] full pass: ${session.sessionName}`)
    const counts = await runLimsPass(session, covering, env, db, today)
    reports.push({ sessionId: session.sessionId, sessionName: session.sessionName, ...counts })
    await db.update(sessions).set({ lastSyncedAt: nowDb() }).where(eq(sessions.sessionId, session.sessionId))
  }
  return reports
}

function limsSessionRows(db: LsDb) {
  return db.select().from(sessions).where(and(
    eq(sessions.state, LIMS_STATE),
    gte(sessions.sessionId, LIMS_SESSION_ID_BASE),
    lt(sessions.sessionId, LIMS_SESSION_ID_BASE * 2),
  )).all()
}

async function currentLimsSession(db: LsDb, today: string) {
  const rows = await limsSessionRows(db)
  const year = Number(today.slice(0, 4))
  return rows.find(r => r.prior === 0 && r.yearStart <= year && year <= r.yearEnd)
    ?? rows.find(r => r.prior === 0)
    ?? null
}

function pickCurrentPeriod(periods: LimsCouncilPeriod[], today: string): LimsCouncilPeriod | null {
  const inRange = periods.find(p => p.startDate.slice(0, 10) <= today && today <= p.endDate.slice(0, 10))
  return inRange ?? [...periods].sort((a, b) => b.councilPeriodId - a.councilPeriodId)[0] ?? null
}

async function upsertPeriod(db: LsDb, cp: LimsCouncilPeriod, prior: 0 | 1): Promise<void> {
  const name = councilPeriodName(cp)
  await db.insert(sessions).values({
    sessionId: limsSessionId(cp.councilPeriodId),
    state: LIMS_STATE,
    stateId: DC_STATE_ID,
    yearStart: Number(cp.startDate.slice(0, 4)),
    yearEnd: Number(cp.endDate.slice(0, 4)),
    sessionTag: `CP${cp.councilPeriodId}`,
    sessionTitle: name,
    sessionName: name,
    prior,
    sineDie: 0,
  }).onConflictDoUpdate({
    target: sessions.sessionId,
    set: { sessionTitle: name, sessionName: name, prior },
  })
}

/**
 * Upsert the current Council Period as a session (plus the previous one while
 * it is within a year of ending), and the current Councilmembers as people.
 */
export async function refreshCouncilPeriod(apiKey: string, db: LsDb, today: string): Promise<void> {
  const periods = await getCouncilPeriods(apiKey, () => trackLimsCall(db, 'CouncilPeriods', {}))
  const cp = pickCurrentPeriod(periods, today)
  if (!cp) return

  // Any other LIMS session stops being current.
  await db.update(sessions).set({ prior: 1 }).where(and(
    gte(sessions.sessionId, LIMS_SESSION_ID_BASE),
    lt(sessions.sessionId, LIMS_SESSION_ID_BASE * 2),
  ))
  await upsertPeriod(db, cp, 0)
  const previous = periods.find(p => p.councilPeriodId === cp.councilPeriodId - 1)
  if (previous && Number(previous.endDate.slice(0, 4)) >= Number(today.slice(0, 4)) - 1) {
    await upsertPeriod(db, previous, 1)
  }

  // Members of every Council Period whose measures central holds, not just the
  // current one: a bill from an earlier period (the previous period, or one
  // imported with lims-import) names sponsors who may have left the Council.
  // The current period goes last, so its record wins where a name repeats.
  const imported = (await db.selectDistinct({ id: limsRecords.councilPeriodId }).from(limsRecords).all()).map(r => r.id)
  const periodIds = [...new Set([...(previous ? [previous.councilPeriodId] : []), ...imported])]
    .filter(id => id !== cp.councilPeriodId).sort((a, b) => a - b)
  periodIds.push(cp.councilPeriodId)
  for (const periodId of periodIds) await upsertMembers(apiKey, db, periodId)
}

async function upsertMembers(apiKey: string, db: LsDb, councilPeriodId: number): Promise<void> {
  const members = await getMembers(councilPeriodId, apiKey,
    () => trackLimsCall(db, 'Members', { councilPeriodId }))
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
): Promise<{ records: number; queued: number; refreshed: number }> {
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
  if (records.length === 0) return { records: 0, queued: 0, refreshed: 0 }

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
    entries.push(toMasterListEntry(rec, billId, await effectiveChangeHash(rec, hash, today), storedDesc.get(billId) ?? null, today))
  }
  for (let i = 0; i < stmts.length; i += FLUSH_BATCH) {
    const chunk = stmts.slice(i, i + FLUSH_BATCH) as [any, ...any[]]
    if (chunk.length > 0) await db.batch(chunk)
  }

  const queue = env.LIMS_INGESTOR_QUEUE ?? env.INGESTOR_QUEUE
  const queued = new Set(await applyMasterList(session, entries, coveringTenants, env, db, queue,
    { deferQueuedUpdates: true }))

  // Re-fetch details for tracked, unsettled bills whose details are stale.
  const stale = await db.selectDistinct({ billId: limsRecords.billId, fetchedAt: limsRecords.detailsFetchedAt })
    .from(limsRecords)
    .innerJoin(billTenants, eq(billTenants.billId, limsRecords.billId))
    .innerJoin(bills, eq(bills.billId, limsRecords.billId))
    .where(and(
      eq(limsRecords.councilPeriodId, councilPeriodId),
      isNotNull(billTenants.matchType),
      notInArray(bills.status, SETTLED_STATUSES),
      or(isNull(limsRecords.detailsFetchedAt), lt(limsRecords.detailsFetchedAt, sql`datetime('now', ${DETAILS_MAX_AGE})`)),
    ))
    .orderBy(asc(limsRecords.detailsFetchedAt))
    .limit(DETAILS_REFRESH_PER_PASS + queued.size)
    .all()
  const refresh = stale.map(r => r.billId).filter(id => !queued.has(id)).slice(0, DETAILS_REFRESH_PER_PASS)
  for (let i = 0; i < refresh.length; i += 100) {
    await queue.sendBatch(refresh.slice(i, i + 100).map(billId => ({ body: { billId } })))
  }
  if (refresh.length > 0) console.log(`[sync-lims] refreshing details for ${refresh.length} tracked bills`)
  return { records: records.length, queued: queued.size, refreshed: refresh.length }
}

/** LIMS category id for each measure-number prefix (GET LegislationCategories). */
const CATEGORY_BY_PREFIX: Record<string, number> = {
  B: 1, PR: 6, CER: 6, CA: 12, GBM: 13, REPROG: 14, HFA: 15,
  RC: 16, ANC: 16, AU: 16, CFO: 16, IG: 16, HN: 18, HR: 19, AG: 26,
}

export interface LimsImportResult {
  imported: string[]
  notFound: string[]
  invalid: string[]
}

/**
 * Import specific LIMS measures, from any Council Period, for one tenant and
 * track them there as manual picks (so each gets a full ingest and AI analysis
 * whatever the tenant's keywords). The scheduled sync covers only the current
 * period and, for a year, the previous one; this is how a team pulls in older
 * measures it still works from (e.g. B25-0345, the Secure DC Omnibus) without
 * importing the whole period. One BulkData call per (period, category) group.
 */
export async function importLimsMeasures(
  env: LsEnv,
  db: LsDb,
  tenantId: string,
  numbers: string[],
): Promise<LimsImportResult> {
  const tenant = await db.select().from(tenants).where(eq(tenants.tenantId, tenantId)).get()
  if (!tenant) throw new Error(`tenant ${tenantId} not found`)
  const apiKey = env.LIMS_API_KEY!
  const today = nowDb().slice(0, 10)
  const result: LimsImportResult = { imported: [], notFound: [], invalid: [] }

  // Group by (Council Period, category): one BulkData call each.
  const groups = new Map<string, { cp: number; category: number; numbers: Set<string> }>()
  for (const raw of numbers) {
    const number = clean(raw).toUpperCase()
    const m = /^([A-Z]+)(\d{1,2})-(\d{1,5})$/.exec(number)
    const category = m ? CATEGORY_BY_PREFIX[m[1]] : undefined
    if (!m || !category || limsBillId(number) === null) { result.invalid.push(raw); continue }
    const key = `${m[2]}:${category}`
    const g = groups.get(key) ?? { cp: Number(m[2]), category, numbers: new Set<string>() }
    // Normalise the sequence to LIMS's four-digit form ("B25-345" → "B25-0345").
    g.numbers.add(`${m[1]}${m[2]}-${m[3].padStart(4, '0')}`)
    groups.set(key, g)
  }
  if (groups.size === 0) return result

  const periods = new Map((await getCouncilPeriods(apiKey, () => trackLimsCall(db, 'CouncilPeriods', {})))
    .map(p => [p.councilPeriodId, p]))
  const queue = env.LIMS_INGESTOR_QUEUE ?? env.INGESTOR_QUEUE
  const covering = [{ tenantId, stateCoverage: tenant.stateCoverage, queueId: tenant.queueId ?? null }]

  for (const g of groups.values()) {
    const cp = periods.get(g.cp)
    if (!cp) { result.notFound.push(...g.numbers); continue }
    // Create the period's session if this central has never seen it. An existing
    // row is left alone, so importing from the current period changes nothing.
    await db.insert(sessions).values({
      sessionId: limsSessionId(cp.councilPeriodId),
      state: LIMS_STATE,
      stateId: DC_STATE_ID,
      yearStart: Number(cp.startDate.slice(0, 4)),
      yearEnd: Number(cp.endDate.slice(0, 4)),
      sessionTag: `CP${cp.councilPeriodId}`,
      sessionTitle: councilPeriodName(cp),
      sessionName: councilPeriodName(cp),
      prior: 1,
      sineDie: cp.endDate.slice(0, 10) < today ? 1 : 0,
    }).onConflictDoNothing()
    const session = { sessionId: limsSessionId(cp.councilPeriodId), state: LIMS_STATE, sessionName: councilPeriodName(cp) }

    const rows = await getBulkData(g.category, g.cp, apiKey,
      () => trackLimsCall(db, 'BulkData', { categoryId: g.category, councilPeriodId: g.cp, reason: 'import' }))
    const wanted = rows.filter(r => g.numbers.has(clean(r.legislationNumber)))
    const found = new Set(wanted.map(r => clean(r.legislationNumber)))
    result.notFound.push(...[...g.numbers].filter(n => !found.has(n)))
    if (wanted.length === 0) continue

    const entries = []
    const ids: number[] = []
    for (const rec of wanted) {
      const billId = limsBillId(rec.legislationNumber)!
      const hash = await bulkHash(rec)
      const values = {
        billId,
        legislationNumber: clean(rec.legislationNumber),
        councilPeriodId: g.cp,
        categoryId: g.category,
        bulkJson: JSON.stringify(rec),
        bulkHash: hash,
        updatedAt: nowDb(),
      }
      const { billId: _id, ...update } = values
      await db.insert(limsRecords).values(values).onConflictDoUpdate({ target: limsRecords.billId, set: update })
      const stored = await db.select({ description: bills.description }).from(bills).where(eq(bills.billId, billId)).get()
      entries.push(toMasterListEntry(rec, billId, await effectiveChangeHash(rec, hash, today), stored?.description ?? null, today))
      ids.push(billId)
    }

    const queued = new Set(await applyMasterList(session, entries, covering, env, db, queue, { deferQueuedUpdates: true }))
    for (const billId of ids) {
      await db.insert(billTenants).values({ billId, tenantId, matchType: 'manual' })
        .onConflictDoUpdate({ target: [billTenants.billId, billTenants.tenantId], set: { matchType: 'manual' } })
    }
    const toQueue = ids.filter(id => !queued.has(id))
    for (let i = 0; i < toQueue.length; i += 100) {
      await queue.sendBatch(toQueue.slice(i, i + 100).map(billId => ({ body: { billId, interactive: true } })))
    }
    result.imported.push(...found)
  }
  return result
}

/**
 * Pull the Council's hearing calendar for last month through three months
 * ahead into council_events. An event missing from a month the feed returned is
 * marked removed (the Council dropped or moved it); a month that failed to load
 * is left untouched, so an outage never empties the calendar.
 */
export async function syncCouncilCalendar(db: LsDb, today: string): Promise<{ months: number; events: number; removed: number }> {
  const year = Number(today.slice(0, 4))
  const month = Number(today.slice(5, 7))
  let events = 0
  let removed = 0
  let months = 0
  for (let offset = -1; offset <= 3; offset++) {
    const d = new Date(Date.UTC(year, month - 1 + offset, 1))
    const y = d.getUTCFullYear()
    const m = d.getUTCMonth() + 1
    let rows
    try {
      rows = await getHearingsCalendar(m, y, () => trackLimsCall(db, 'HearingsCalendar', { year: y, month: m }))
    } catch (err) {
      console.error(`[sync-lims] council calendar ${y}-${m} failed:`, err)
      continue
    }
    months++
    const monthPrefix = `${y}-${String(m).padStart(2, '0')}`
    const seen: number[] = []
    for (const h of rows) {
      if (!h || typeof h.hearingId !== 'number' || typeof h.hearingDateTime !== 'string') continue
      const date = h.hearingDateTime.slice(0, 10)
      const hhmm = h.hearingDateTime.slice(11, 16)
      const values = {
        hearingId: h.hearingId,
        date,
        time: /^\d{2}:\d{2}$/.test(hhmm) && hhmm !== '00:00' ? hhmm : null,
        hearingType: clean(h.hearingType) || 'Hearing',
        title: clean(h.hearingTitle) || 'Council',
        jointWith: clean(h.jointHearingCommittees) || null,
        location: clean(h.location) || null,
        topicsJson: JSON.stringify((h.topics ?? []).map(t => ({ topic: clean(t.topic), number: clean(t.legislationNumber) || null }))),
        witnessJson: h.witnessListAttachment ? JSON.stringify(h.witnessListAttachment) : null,
        eventHash: '',
        removedAt: null,
        updatedAt: nowDb(),
      }
      values.eventHash = (await sha256Hex(JSON.stringify([values.date, values.time, values.hearingType, values.title, values.jointWith, values.location, values.topicsJson]))).slice(0, 32)
      const { hearingId: _id, ...update } = values
      await db.insert(councilEvents).values(values).onConflictDoUpdate({ target: councilEvents.hearingId, set: update })
      seen.push(h.hearingId)
      events++
    }
    const stale = await db.select({ hearingId: councilEvents.hearingId }).from(councilEvents)
      .where(and(sql`substr(${councilEvents.date}, 1, 7) = ${monthPrefix}`, isNull(councilEvents.removedAt)))
      .all()
    for (const r of stale) {
      if (seen.includes(r.hearingId)) continue
      await db.update(councilEvents).set({ removedAt: nowDb() }).where(eq(councilEvents.hearingId, r.hearingId))
      removed++
    }
  }
  console.log(`[sync-lims] council calendar: ${events} events over ${months} months, ${removed} removed`)
  return { months, events, removed }
}
