import { and, eq, gte, inArray, lt, sql } from 'drizzle-orm'
import { providerCache } from '../db/schema'
import type { Db } from '../types'

/**
 * What a provider keeps between runs (`ProviderContext.cache`): small text
 * entries under keys it names, in `provider_cache`. For what a provider fetched
 * once and shouldn't fetch again, when its feed answers one request per record
 * and allows few of them (GovInfo's committee meetings, from an API that allows
 * 10 requests a minute). Each provider's entries are its own, and nothing
 * expires: the provider drops what it no longer needs.
 */

/** D1 binds at most 100 parameters per statement, and a delete binds one per key plus the provider's. */
const DROP_CHUNK = 90
/** An upsert of three values per entry binds three parameters each. */
const PUT_CHUNK = 30
/** And no one statement carries more than this much text, since D1 limits a statement's size. */
const PUT_BYTES = 64 * 1024
/** Statements to a batch. */
const BATCH = 50

/** The code point above every other, so a key range from a prefix to prefix + this holds exactly the keys that start with the prefix. */
const ABOVE_ALL = '\u{10FFFF}'

async function batch(db: Db, stmts: any[]): Promise<void> {
  for (let i = 0; i < stmts.length; i += BATCH) await db.batch(stmts.slice(i, i + BATCH) as [any, ...any[]])
}

/** Every entry of a provider whose key starts with `prefix` (the empty prefix lists them all), by key. */
export async function providerCacheList(db: Db, provider: string, prefix: string): Promise<Map<string, string>> {
  // A range over the keys, not LIKE, so a "%" or "_" in a prefix is the character it is.
  const rows = await db.select({ key: providerCache.key, value: providerCache.value }).from(providerCache)
    .where(and(eq(providerCache.provider, provider), gte(providerCache.key, prefix), lt(providerCache.key, prefix + ABOVE_ALL)))
    .all()
  return new Map(rows.map(r => [r.key, r.value]))
}

/** Add these entries to a provider's, replacing any with the same key. */
export async function providerCachePut(db: Db, provider: string, entries: Readonly<Record<string, string>>): Promise<void> {
  const pairs = Object.entries(entries)
  for (const [key, value] of pairs) {
    if (!key) throw new Error(`provider cache: ${provider} put an entry with no key`)
    if (typeof value !== 'string') throw new Error(`provider cache: ${provider}'s entry ${key} is not text`)
  }
  const stmts: any[] = []
  let group: [string, string][] = []
  let bytes = 0
  const flush = () => {
    if (group.length === 0) return
    stmts.push(db.insert(providerCache)
      .values(group.map(([key, value]) => ({ provider, key, value })))
      .onConflictDoUpdate({
        target: [providerCache.provider, providerCache.key],
        set: { value: sql`excluded.value`, updatedAt: sql`datetime('now')` },
      }))
    group = []
    bytes = 0
  }
  for (const pair of pairs) {
    // A statement holds a few entries, and no more text than D1 takes in one.
    if (group.length >= PUT_CHUNK || (group.length > 0 && bytes + pair[1].length > PUT_BYTES)) flush()
    group.push(pair)
    bytes += pair[1].length
  }
  flush()
  await batch(db, stmts)
}

/** Remove these keys from a provider's entries. A key that isn't there is ignored. */
export async function providerCacheDrop(db: Db, provider: string, keys: readonly string[]): Promise<void> {
  const unique = [...new Set(keys)]
  const stmts: any[] = []
  for (let i = 0; i < unique.length; i += DROP_CHUNK) {
    stmts.push(db.delete(providerCache)
      .where(and(eq(providerCache.provider, provider), inArray(providerCache.key, unique.slice(i, i + DROP_CHUNK)))))
  }
  await batch(db, stmts)
}
