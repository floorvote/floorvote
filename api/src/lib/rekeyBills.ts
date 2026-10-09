import { eq, inArray } from 'drizzle-orm'
import { bills } from '../db/schema'
import type { AppDb } from '../types'

export interface RekeyResult {
  /** Bills whose central id was changed. */
  rekeyed: number
  /** Old ids this team has no bill for. */
  missing: string[]
  /** Pairs left alone because the team already has a bill under the new id. */
  conflicts: string[]
}

/**
 * Point this team's bills at new central ids, keeping everything the team has
 * attached to them (positions, notes, votes, analyses): central is moving a
 * state from LegiScan to a direct source, and each LegiScan bill has a
 * counterpart under a new id. Only `bills.external_id` holds central ids.
 */
export async function rekeyBills(db: AppDb, pairs: { from: string; to: string }[]): Promise<RekeyResult> {
  const result: RekeyResult = { rekeyed: 0, missing: [], conflicts: [] }
  const CHUNK = 90
  const existing = new Set<string>()
  const targets = new Set<string>()
  for (let i = 0; i < pairs.length; i += CHUNK) {
    const chunk = pairs.slice(i, i + CHUNK)
    for (const r of await db.select({ id: bills.externalId }).from(bills)
      .where(inArray(bills.externalId, chunk.map(p => p.from))).all()) existing.add(r.id!)
    for (const r of await db.select({ id: bills.externalId }).from(bills)
      .where(inArray(bills.externalId, chunk.map(p => p.to))).all()) targets.add(r.id!)
  }

  const updates = []
  for (const p of pairs) {
    if (!existing.has(p.from)) { result.missing.push(p.from); continue }
    if (targets.has(p.to)) { result.conflicts.push(p.from); continue }
    updates.push(db.update(bills).set({ externalId: p.to }).where(eq(bills.externalId, p.from)))
    result.rekeyed++
  }
  for (let i = 0; i < updates.length; i += 100) {
    const chunk = updates.slice(i, i + 100)
    await db.batch(chunk as [typeof chunk[0], ...typeof chunk])
  }
  return result
}
