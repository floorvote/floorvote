import { and, eq, inArray } from 'drizzle-orm'
import { providerIds } from '../db/schema'
import type { Db } from '../types'

/** D1 binds at most 100 parameters per statement. */
const SELECT_CHUNK = 90
const INSERT_CHUNK = 30

/**
 * Central integer ids for a provider's records, one per (provider, kind,
 * native key), allocated on first sight from one sequence (provider_ids).
 * The same key always maps to the same id. Providers reach it as
 * ProviderContext.ids.
 */
export async function providerIdsFor(
  db: Db, provider: string, kind: string, keys: readonly string[],
): Promise<Map<string, number>> {
  const unique = [...new Set(keys)]
  const ids = await knownProviderIds(db, provider, kind, unique)
  const missing = unique.filter(k => !ids.has(k))
  if (missing.length === 0) return ids

  const stmts = []
  for (let i = 0; i < missing.length; i += INSERT_CHUNK) {
    stmts.push(db.insert(providerIds)
      .values(missing.slice(i, i + INSERT_CHUNK).map(nativeKey => ({ provider, kind, nativeKey })))
      .onConflictDoNothing())
  }
  await db.batch(stmts as [typeof stmts[0], ...typeof stmts])
  for (const [key, id] of await knownProviderIds(db, provider, kind, missing)) ids.set(key, id)
  return ids
}

/**
 * The central ids already allocated for these keys, minting none: a key never
 * seen is left out. Providers reach it as ProviderContext.knownIds.
 */
export async function knownProviderIds(
  db: Db, provider: string, kind: string, keys: readonly string[],
): Promise<Map<string, number>> {
  const wanted = [...new Set(keys)]
  const ids = new Map<string, number>()
  for (let i = 0; i < wanted.length; i += SELECT_CHUNK) {
    const rows = await db.select({ id: providerIds.id, key: providerIds.nativeKey }).from(providerIds)
      .where(and(eq(providerIds.provider, provider), eq(providerIds.kind, kind), inArray(providerIds.nativeKey, wanted.slice(i, i + SELECT_CHUNK))))
      .all()
    for (const r of rows) ids.set(r.key, r.id)
  }
  return ids
}
