import { eq, and, gte, lt } from 'drizzle-orm'
import { getLegislationDetails, type LimsBulkRecord } from './lims'
import { buildLimsBill, personKey, type LimsPerson } from './lims-map'
import { limsSessionId, LIMS_PEOPLE_ID_BASE } from './lims-ids'
import { limsRecords, sessions, people, apiCallLog } from '../db/schema-legiscan'
import { nowDb } from './dbTime'
import type { LegiscanBill } from './legiscan'
import type { LsEnv, LsDb } from '../types-legiscan'

export function trackLimsCall(db: LsDb, callType: string, params: Record<string, unknown>): void {
  db.insert(apiCallLog)
    .values({ loggedAt: nowDb(), callType: `lims:${callType}`, params: JSON.stringify(params) })
    .catch(err => console.error('[lims] failed to log API call:', err))
}

/**
 * Build the full LegiScan-shaped record for one LIMS bill: the BulkData record
 * the sync stored, plus a fresh LegislationDetails call (one LIMS call).
 */
export async function fetchLimsBill(billId: number, env: LsEnv, db: LsDb): Promise<LegiscanBill> {
  if (!env.LIMS_API_KEY) throw new Error(`bill ${billId} is a LIMS bill but LIMS_API_KEY is not set`)
  const row = await db.select().from(limsRecords).where(eq(limsRecords.billId, billId)).get()
  if (!row) throw new Error(`bill ${billId} has no stored LIMS record; the LIMS sync has not seen it`)

  const rec = JSON.parse(row.bulkJson) as LimsBulkRecord
  const details = await getLegislationDetails(row.legislationNumber, env.LIMS_API_KEY,
    () => trackLimsCall(db, 'LegislationDetails', { number: row.legislationNumber }))

  const sessionId = limsSessionId(row.councilPeriodId)
  const s = await db.select().from(sessions).where(eq(sessions.sessionId, sessionId)).get()
  const session = {
    session_id: sessionId,
    session_name: s?.sessionName ?? `Council Period ${row.councilPeriodId}`,
    year_start: s?.yearStart ?? 0,
    year_end: s?.yearEnd ?? 0,
  }

  const members = await db.select({ peopleId: people.peopleId, name: people.name, role: people.role })
    .from(people)
    .where(and(gte(people.peopleId, LIMS_PEOPLE_ID_BASE), lt(people.peopleId, LIMS_PEOPLE_ID_BASE * 2)))
    .all()
  const byKey = new Map<string, LimsPerson>()
  for (const m of members) byKey.set(personKey(m.name), { peopleId: m.peopleId, name: m.name, role: m.role ?? '' })

  return buildLimsBill(rec, details, billId, row.bulkHash, { session, people: byKey, today: nowDb().slice(0, 10) })
}
