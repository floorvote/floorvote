import { eq } from 'drizzle-orm'
import { billCommittees } from '../db/schema'
import type { AppDb } from '../types'

/** A committee as central's bill API sends it: the pending committee, or a referral's. */
export type CentralCommittee = { committeeId: string | null; name: string; chamber: string | null }

/** Rows per insert: six bound parameters each, under D1's limit of 100. */
const INSERT_CHUNK = 15

/**
 * The bill's committees (#471), replaced on every write of the bill as its subjects are: one row for each committee
 * central names, its pending committee (marked current) and each committee it was referred to. A referral with no
 * committee id (DC's "Retained by the Council") has no row. A committee keeps the name and chamber of its latest
 * mention, the pending committee's when that is one. The delete and the inserts run as one batch, which D1 runs as one
 * transaction, so a write that fails leaves the rows it would have replaced.
 */
export async function syncBillCommittees(
  db: AppDb, billInternalId: string, state: string,
  pending: CentralCommittee | null | undefined, referrals: CentralCommittee[] | undefined,
): Promise<void> {
  await db.batch(billCommitteeStatements(db, billInternalId, state, pending, referrals))
}

/**
 * The statements that replace a bill's committee rows: the delete, then the chunked inserts. The full delivery path
 * puts them in the one batch that also writes the bill and stamps its version (#906).
 */
export function billCommitteeStatements(
  db: AppDb, billInternalId: string, state: string,
  pending: CentralCommittee | null | undefined, referrals: CentralCommittee[] | undefined,
) {
  const rows = new Map<string, typeof billCommittees.$inferInsert>()
  for (const r of referrals ?? []) {
    if (!r.committeeId || !r.name) continue
    rows.set(r.committeeId, { billId: billInternalId, committeeId: r.committeeId, state, name: r.name, chamber: r.chamber, isCurrent: false })
  }
  if (pending?.committeeId && pending.name) {
    rows.set(pending.committeeId, { billId: billInternalId, committeeId: pending.committeeId, state, name: pending.name, chamber: pending.chamber, isCurrent: true })
  }
  const values = [...rows.values()]
  const inserts = []
  for (let i = 0; i < values.length; i += INSERT_CHUNK) inserts.push(db.insert(billCommittees).values(values.slice(i, i + INSERT_CHUNK)))
  return [db.delete(billCommittees).where(eq(billCommittees.billId, billInternalId)), ...inserts] as const
}
