import { and, asc, eq, sql } from 'drizzle-orm'
import { billReferrals, committees } from '../db/schema'
import type { CentralMeasure, Provider } from '../providers'
import type { Db } from '../types'

/**
 * Committees (#299): one row per committee a bill names, so a committee keeps
 * one name across bills and referrals point at a real row. The provider sets
 * each committee's id on the measure: LegiScan's own `committee_id`, or one a
 * provider minted from central's id table (ProviderContext.ids, kind
 * 'committee'). No memberships, chairs, or staff.
 */

/** Rows per insert: seven bound parameters each, under D1's limit of 100. */
const INSERT_CHUNK = 12

/**
 * Upsert every committee the measure names, in its pending committee or its
 * referrals. A referral without an id (a provider that has none for it, or
 * DC's "Retained by the Council") names no committee and writes no row.
 *
 * A committee keeps the provider and id that first wrote it. Its name and
 * chamber follow the latest ingest that names it from its latest session, so
 * a renamed committee is renamed on every bill at once, and re-ingesting an
 * older session's bill can't bring back an old name.
 */
export async function upsertCommittees(db: Db, measure: CentralMeasure, provider: Provider): Promise<void> {
  const named = new Map<number, typeof committees.$inferInsert>()
  const add = (c: { committee_id: number; chamber: string; chamber_id: number; name: string }) => {
    const name = c.name?.trim()
    if (!c.committee_id || !name) return
    named.set(c.committee_id, {
      committeeId: c.committee_id, state: measure.state, sessionId: measure.session_id,
      chamber: c.chamber || '', chamberId: c.chamber_id || 0, name, provider: provider.id,
    })
  }
  // LegiScan sends `committee: []` for a bill with no pending committee.
  if (measure.committee && !Array.isArray(measure.committee)) add(measure.committee)
  for (const r of measure.referrals ?? []) add(r)
  await upsertCommitteeRows(db, [...named.values()], provider)
}

/**
 * Upsert committees rows a provider names, under the rule above: a row keeps
 * the provider and id that first wrote it, and takes its name and chamber
 * from its latest session. Also how body events (lib/bodyEvents.ts) record
 * the committees holding them.
 */
export async function upsertCommitteeRows(db: Db, rows: (typeof committees.$inferInsert)[], provider: Provider): Promise<void> {
  if (rows.length === 0) return
  const inserts = []
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    inserts.push(db.insert(committees).values(rows.slice(i, i + INSERT_CHUNK)).onConflictDoUpdate({
      target: committees.committeeId,
      set: {
        name: sql`excluded.name`,
        chamber: sql`excluded.chamber`,
        chamberId: sql`excluded.chamber_id`,
        sessionId: sql`excluded.session_id`,
      },
      // Only from the committee's latest session. Another provider's row under
      // the same id is left alone: minted ids start above 3e9, so that only
      // guards against a provider's mistake.
      setWhere: and(eq(committees.provider, provider.id), sql`excluded.session_id >= ${committees.sessionId}`),
    }))
  }
  await db.batch(inserts as [typeof inserts[0], ...typeof inserts])
}

/** A committee as the bill API sends it. */
export interface CommitteeRef {
  committeeId: string
  name: string
  chamber: string | null
}

/** A referral as the bill API sends it: the committee's own name when the referral names one. */
export interface ReferralDetail {
  date: string | null
  committeeId: string | null
  name: string
  chamber: string | null
}

/** The bill's pending committee, from its committees row. */
export async function pendingCommittee(db: Db, committeeId: number | null): Promise<CommitteeRef | null> {
  if (!committeeId) return null
  const row = await db.select({ name: committees.name, chamber: committees.chamber })
    .from(committees).where(eq(committees.committeeId, committeeId)).get()
  return row ? { committeeId: String(committeeId), name: row.name, chamber: row.chamber || null } : null
}

/** The bill's referrals in the order the provider listed them, each named by its committee's row. */
export async function billReferralDetails(db: Db, billId: number): Promise<ReferralDetail[]> {
  const rows = await db.select({
    date: billReferrals.date,
    committeeId: billReferrals.committeeId,
    referralName: billReferrals.name,
    chamber: billReferrals.chamber,
    committeeName: committees.name,
  })
    .from(billReferrals)
    .leftJoin(committees, eq(committees.committeeId, billReferrals.committeeId))
    .where(eq(billReferrals.billId, billId))
    // The ingest deletes and reinserts a bill's referrals in the provider's order.
    .orderBy(asc(sql`${billReferrals}.rowid`))
    .all()
  return rows.flatMap(r => {
    const name = r.committeeName ?? r.referralName
    if (!name) return []
    return [{
      date: r.date || null,
      committeeId: r.committeeName != null && r.committeeId ? String(r.committeeId) : null,
      name,
      chamber: r.chamber || null,
    }]
  })
}
