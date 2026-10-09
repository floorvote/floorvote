import { eq, and, asc } from 'drizzle-orm'
import { getLegislationDetails, type LimsBulkRecord } from './lims'
import { buildLimsBill, effectiveChangeHash, indexPeople } from './lims-map'
import { LIMS_SESSION_ID_BASE } from './lims-ids'
import { sourceRecords, sessions, people, apiCallLog } from '../db/schema'
import { nowDb } from './dbTime'
import type { CentralMeasure } from '../providers'
import type { Env, Db } from '../types'

export function trackLimsCall(db: Db, callType: string, params: Record<string, unknown>): void {
  db.insert(apiCallLog)
    .values({ loggedAt: nowDb(), callType: `lims:${callType}`, params: JSON.stringify(params) })
    .catch(err => console.error('[lims] failed to log API call:', err))
}

/**
 * Build the full LegiScan-shaped record for one LIMS bill: the BulkData record
 * the sync stored, plus a fresh LegislationDetails call (one LIMS call).
 */
export async function fetchLimsBill(billId: number, env: Env, db: Db): Promise<CentralMeasure> {
  if (!env.LIMS_API_KEY) throw new Error(`bill ${billId} is a LIMS bill but LIMS_API_KEY is not set`)
  const row = await db.select().from(sourceRecords)
    .where(and(eq(sourceRecords.billId, billId), eq(sourceRecords.source, 'lims'))).get()
  if (!row) throw new Error(`bill ${billId} has no stored LIMS record; the LIMS sync has not seen it`)

  const rec = JSON.parse(row.rawJson) as LimsBulkRecord
  const details = await getLegislationDetails(row.nativeKey, env.LIMS_API_KEY,
    () => trackLimsCall(db, 'LegislationDetails', { number: row.nativeKey }))

  const sessionId = row.sessionId
  const s = await db.select().from(sessions).where(eq(sessions.sessionId, sessionId)).get()
  const session = {
    session_id: sessionId,
    session_name: s?.sessionName ?? `Council Period ${sessionId - LIMS_SESSION_ID_BASE}`,
    year_start: s?.yearStart ?? 0,
    year_end: s?.yearEnd ?? 0,
  }

  const members = await db.select({ peopleId: people.peopleId, name: people.name, role: people.role })
    .from(people)
    .where(eq(people.source, 'lims'))
    // LIMS member ids grow over time: in ascending order the latest record for a
    // name is indexed last and wins, and members who left stay findable.
    .orderBy(asc(people.peopleId))
    .all()
  const byKey = indexPeople(members.map(m => ({ peopleId: m.peopleId, name: m.name, role: m.role ?? '' })))

  await db.update(sourceRecords).set({ detailsFetchedAt: nowDb() }).where(eq(sourceRecords.billId, billId))

  // The same change_hash the sync compares against (see effectiveChangeHash).
  const today = nowDb().slice(0, 10)
  const hash = await effectiveChangeHash(rec, row.rawHash, today)
  return buildLimsBill(rec, details, billId, hash, { session, people: byKey, today })
}
