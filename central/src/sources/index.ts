import { eq } from 'drizzle-orm'
import { bills, sourceRecords } from '../db/schema-legiscan'
import { limsSource } from './lims'
import { mgaSource } from './mga'
import { lisSource } from './lis'
import type { DirectSource } from './types'
import type { LsEnv, LsDb } from '../types-legiscan'

export type { DirectSource } from './types'

/** Every direct source central knows. A deployment enables each by configuration. */
export const SOURCES: readonly DirectSource[] = [limsSource, mgaSource, lisSource]

export function directSource(id: string | null | undefined): DirectSource | undefined {
  return SOURCES.find(s => s.id === id)
}

/** States this deployment reads from a direct source rather than LegiScan. */
export function directStates(env: LsEnv): Set<string> {
  return new Set(SOURCES.filter(s => s.enabled(env)).flatMap(s => s.states))
}

/**
 * Which source a bill comes from: a direct source's id, or 'legiscan'. A direct
 * source stores the bill's raw record before the bill is ever queued; the bill
 * row's own column covers a bill whose record has gone missing, so it still
 * never reaches LegiScan.
 */
export async function billSource(db: LsDb, billId: number): Promise<string> {
  const rec = await db.select({ source: sourceRecords.source }).from(sourceRecords)
    .where(eq(sourceRecords.billId, billId)).get()
  if (rec) return rec.source
  const bill = await db.select({ source: bills.source }).from(bills).where(eq(bills.billId, billId)).get()
  return bill?.source ?? 'legiscan'
}
