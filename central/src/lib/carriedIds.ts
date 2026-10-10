import { and, asc, eq, isNull } from 'drizzle-orm'
import { cutoverBills, cutoverPeople, cutovers } from '../db/schema'
import type { CentralMeasure, ProviderPerson, ProviderRecord } from '../providers'
import type { Db } from '../types'

/**
 * The ids a cutover carried over (lib/cutover.ts). When a state moves to a
 * new provider, each bill it matched keeps its central row id, and each
 * legislator it matched keeps their person id. A provider makes its own ids
 * (minted from provider_ids, or packed from its native ids, as LIMS does), so
 * core gives the kept ones in their place wherever the provider's records
 * reach core: its snapshot records, the people it lists, and the sponsors and
 * votes of its measures. Only cutovers that haven't been undone count.
 */

/** Kept bill ids, by the provider's own key for each bill, in the state the provider was cut over to. */
export async function carriedBillIds(db: Db, providerId: string, state: string): Promise<Map<string, number>> {
  const rows = await db.select({ nativeKey: cutoverBills.nativeKey, billId: cutoverBills.billId })
    .from(cutoverBills)
    .innerJoin(cutovers, eq(cutovers.id, cutoverBills.cutoverId))
    .where(and(eq(cutovers.state, state), eq(cutovers.toProvider, providerId), isNull(cutovers.undoneAt)))
    .orderBy(asc(cutovers.createdAt))
    .all()
  return new Map(rows.map(r => [r.nativeKey, r.billId]))
}

/** The records, each under its kept bill id where a cutover carried one. */
export function withCarriedBillIds(records: ProviderRecord[], carried: Map<string, number>): ProviderRecord[] {
  if (carried.size === 0) return records
  return records.map(r => {
    const billId = carried.get(r.nativeKey)
    return billId === undefined || billId === r.billId ? r : { ...r, billId }
  })
}

/** Kept person ids, by the id the provider has for each person. */
export async function carriedPeopleIds(db: Db, providerId: string): Promise<Map<number, number>> {
  const rows = await db.select({ from: cutoverPeople.providerPeopleId, to: cutoverPeople.peopleId })
    .from(cutoverPeople)
    .innerJoin(cutovers, eq(cutovers.id, cutoverPeople.cutoverId))
    .where(and(eq(cutovers.toProvider, providerId), isNull(cutovers.undoneAt)))
    .orderBy(asc(cutovers.createdAt))
    .all()
  return new Map(rows.map(r => [r.from, r.to]))
}

/** The people, each under their kept id where a cutover carried one. */
export function withCarriedPeople(list: ProviderPerson[], carried: Map<number, number>): ProviderPerson[] {
  if (carried.size === 0) return list
  return list.map(p => {
    const peopleId = carried.get(p.people_id)
    return peopleId === undefined ? p : { ...p, people_id: peopleId }
  })
}

/** The measure, with its sponsors and member votes under kept person ids where a cutover carried them. */
export function measureWithCarriedPeople(measure: CentralMeasure, carried: Map<number, number>): CentralMeasure {
  if (carried.size === 0) return measure
  const kept = (id: number) => carried.get(id) ?? id
  return {
    ...measure,
    sponsors: (measure.sponsors ?? []).map(s => (s.people_id ? { ...s, people_id: kept(s.people_id) } : s)),
    votes: (measure.votes ?? []).map(v => (v.member_votes
      ? { ...v, member_votes: v.member_votes.map(mv => (mv.people_id == null ? mv : { ...mv, people_id: kept(mv.people_id) })) }
      : v)),
  }
}
