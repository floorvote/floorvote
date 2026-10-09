import { eq, and } from 'drizzle-orm'
import { getBulkData, getCouncilPeriods, getMembers, type LimsBulkRecord, type LimsCouncilPeriod } from '../lib/lims'
import { bulkHash, clean, councilPeriodName, DC_STATE_ID, effectiveChangeHash, LIMS_STATE, LIMS_STATUS_LABELS, limsStatusCode, toMasterListEntry } from '../lib/lims-map'
import { limsBillId, limsPeopleId, limsSessionId, LIMS_SESSION_ID_BASE } from '../lib/lims-ids'
import { limsCategories } from '../lib/lims-config'
import { fetchLimsBill, trackLimsCall } from '../lib/lims-ingest'
import { sessions, people, sourceRecords } from '../db/schema-legiscan'
import type { DirectSource, SessionRow, SourceRecord } from './types'
import type { LsDb } from '../types-legiscan'

/**
 * The DC Council's Legislative Information Management System (lib/lims*.ts).
 *
 * A session is a Council Period. Each full pass pulls BulkData for the
 * configured categories of the period (one call per category); the ingestor
 * then adds LegislationDetails for each queued bill (lib/lims-map.ts).
 */

/** Final statuses: nothing further arrives in LegislationDetails. */
const SETTLED_STATUSES = ['Official Law', 'Withdrawn', 'Failed', 'Disapproved', 'Deemed Disapproved', 'Expired', 'Approved', 'Deemed Approved']
  .map(limsStatusCode)
  .concat(limsStatusCode(''))  // oversight notices: details add nothing
const MEMBER_BIO_URL = 'https://dccouncil.gov/councilmembers/'

export const limsSource: DirectSource = {
  id: 'lims',
  states: [LIMS_STATE],
  // Off unless a LIMS key is configured and LIMS_STATES names DC, so a
  // deployment without one keeps DC on LegiScan.
  enabled: env => !!env.LIMS_API_KEY &&
    (env.LIMS_STATES ?? '').split(',').some(s => s.trim().toUpperCase() === LIMS_STATE),
  // LIMS answers 429 above about two concurrent requests.
  ingestQueue: env => env.LIMS_INGESTOR_QUEUE,

  async syncSessions(env, db, ctx) {
    let current = await currentLimsSession(db, ctx.today)
    // Council Periods and members change every two years; refresh daily, or now
    // if this central has never seen a LIMS session.
    if (ctx.force || ctx.etHour === 5 || !current) {
      await refreshCouncilPeriod(env.LIMS_API_KEY!, db, ctx.today)
      current = await currentLimsSession(db, ctx.today)
    }
    if (!current) {
      console.warn('[sync-lims] no current Council Period; skipping')
      return []
    }
    // The previous Council Period keeps syncing for a year after it ends: acts
    // passed late in a period finish Mayoral and Congressional review after it.
    const year = Number(ctx.today.slice(0, 4))
    return [current, ...(await limsSessionRows(db)).filter(r => r.prior === 1 && r.yearEnd >= year - 1)]
  },

  async snapshot(session, env, db) {
    const councilPeriodId = session.sessionId - LIMS_SESSION_ID_BASE
    // One call per category, serially: LIMS rejects concurrent bursts.
    const records: SourceRecord[] = []
    for (const categoryId of limsCategories(env)) {
      const rows = await getBulkData(categoryId, councilPeriodId, env.LIMS_API_KEY!,
        () => trackLimsCall(db, 'BulkData', { categoryId, councilPeriodId }))
      for (const rec of rows) {
        const record = await limsRecord(rec)
        if (record) records.push(record)
      }
    }
    return records
  },

  async toEntry(record, stored, ctx) {
    const rec = record.raw as LimsBulkRecord
    return toMasterListEntry(rec, record.billId, await effectiveChangeHash(rec, record.hash, ctx.today), stored.description, ctx.today)
  },

  buildBill: fetchLimsBill,

  /**
   * LegislationDetails can change while the bulk record does not: a committee
   * report is filed after its mark-up, a vote is recorded, a hearing is
   * cancelled. With three passes a day this is at most 150 extra LIMS calls a day.
   */
  detailsRefresh: { maxAge: '-2 days', perPass: 50, settledStatuses: SETTLED_STATUSES },

  statusLabels: LIMS_STATUS_LABELS,
}

/** A BulkData row as a source record, or null for a measure number lims-ids cannot encode. */
export async function limsRecord(rec: LimsBulkRecord): Promise<SourceRecord | null> {
  const billId = limsBillId(rec.legislationNumber)
  if (billId === null) {
    console.warn(`[sync-lims] skipping unrecognised measure number "${rec.legislationNumber}"`)
    return null
  }
  return { billId, nativeKey: clean(rec.legislationNumber), raw: rec, hash: await bulkHash(rec) }
}

function limsSessionRows(db: LsDb): Promise<SessionRow[]> {
  return db.select().from(sessions).where(and(eq(sessions.state, LIMS_STATE), eq(sessions.source, 'lims'))).all()
}

async function currentLimsSession(db: LsDb, today: string): Promise<SessionRow | null> {
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

/** The `sessions` row for a Council Period. */
export function limsSessionValues(cp: LimsCouncilPeriod, prior: 0 | 1, sineDie: 0 | 1 = 0) {
  const name = councilPeriodName(cp)
  return {
    sessionId: limsSessionId(cp.councilPeriodId),
    state: LIMS_STATE,
    stateId: DC_STATE_ID,
    yearStart: Number(cp.startDate.slice(0, 4)),
    yearEnd: Number(cp.endDate.slice(0, 4)),
    sessionTag: `CP${cp.councilPeriodId}`,
    sessionTitle: name,
    sessionName: name,
    prior,
    sineDie,
    source: 'lims',
  }
}

async function upsertPeriod(db: LsDb, cp: LimsCouncilPeriod, prior: 0 | 1): Promise<void> {
  const values = limsSessionValues(cp, prior)
  await db.insert(sessions).values(values).onConflictDoUpdate({
    target: sessions.sessionId,
    set: { sessionTitle: values.sessionTitle, sessionName: values.sessionName, prior },
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
  await db.update(sessions).set({ prior: 1 }).where(eq(sessions.source, 'lims'))
  await upsertPeriod(db, cp, 0)
  const previous = periods.find(p => p.councilPeriodId === cp.councilPeriodId - 1)
  if (previous && Number(previous.endDate.slice(0, 4)) >= Number(today.slice(0, 4)) - 1) {
    await upsertPeriod(db, previous, 1)
  }

  // Members of every Council Period whose measures central holds, not just the
  // current one: a bill from an earlier period (the previous period, or one
  // imported with lims-import) names sponsors who may have left the Council.
  // The current period goes last, so its record wins where a name repeats.
  const imported = (await db.selectDistinct({ id: sourceRecords.sessionId }).from(sourceRecords)
    .where(eq(sourceRecords.source, 'lims')).all()).map(r => r.id - LIMS_SESSION_ID_BASE)
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
      // LIMS people have no LegiScan profile; this is their sponsor link.
      bioJson: JSON.stringify({ social: { biography: MEMBER_BIO_URL } }),
      source: 'lims',
    }
    const { peopleId: _id, ...update } = values
    await db.insert(people).values(values).onConflictDoUpdate({ target: people.peopleId, set: update })
  }
}
