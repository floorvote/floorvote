import { and, eq, inArray } from 'drizzle-orm'
import { sourceIds } from '../db/schema-legiscan'
import type { LsDb } from '../types-legiscan'

/** D1 binds at most 100 parameters per statement. */
const SELECT_CHUNK = 90
const INSERT_CHUNK = 30

/**
 * Central integer ids for a direct source's records, one per (source, kind,
 * native key), allocated on first sight from one sequence (source_ids).
 * The same key always maps to the same id.
 */
export async function sourceIdsFor(
  db: LsDb, source: string, kind: string, keys: readonly string[],
): Promise<Map<string, number>> {
  const unique = [...new Set(keys)]
  const ids = new Map<string, number>()
  const lookup = async (wanted: string[]) => {
    for (let i = 0; i < wanted.length; i += SELECT_CHUNK) {
      const rows = await db.select({ id: sourceIds.id, key: sourceIds.nativeKey }).from(sourceIds)
        .where(and(eq(sourceIds.source, source), eq(sourceIds.kind, kind), inArray(sourceIds.nativeKey, wanted.slice(i, i + SELECT_CHUNK))))
        .all()
      for (const r of rows) ids.set(r.key, r.id)
    }
  }
  await lookup(unique)
  const missing = unique.filter(k => !ids.has(k))
  if (missing.length === 0) return ids

  const stmts = []
  for (let i = 0; i < missing.length; i += INSERT_CHUNK) {
    stmts.push(db.insert(sourceIds)
      .values(missing.slice(i, i + INSERT_CHUNK).map(nativeKey => ({ source, kind, nativeKey })))
      .onConflictDoNothing())
  }
  await db.batch(stmts as [typeof stmts[0], ...typeof stmts])
  await lookup(missing)
  return ids
}

export async function sourceIdFor(db: LsDb, source: string, kind: string, key: string): Promise<number> {
  return (await sourceIdsFor(db, source, kind, [key])).get(key)!
}
