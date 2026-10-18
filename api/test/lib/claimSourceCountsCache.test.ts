import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { resetDb, applyMigrations, seedBill } from '../helpers'
import { getDb } from '../../src/db/client'
import { associationConfig } from '../../src/db/schema'
import { cachedClaimSourceCounts, recordClaimSourcesCutOff } from '../../src/lib/claimSourceCounts'

// The count scans every bill's stored claim sources, and D1 runs one query at a
// time per database, so an operator reloading the page must not rerun it each
// time (#573 review). The counts are cached for a window, and the view shows how
// old they are.

const WINDOW_MS = 30 * 60 * 1000
const T0 = Date.parse('2026-03-01T12:00:00.000Z')

/** The real database, with every statement it is asked to prepare recorded. */
function counting() {
  const statements: string[] = []
  const db = new Proxy(env.DB, {
    get(target, prop) {
      if (prop === 'prepare') return (q: string) => { statements.push(q); return target.prepare(q) }
      const v = (target as any)[prop]
      return typeof v === 'function' ? v.bind(target) : v
    },
  }) as typeof env.DB
  return { db: getDb(db), scans: () => statements.filter(q => q.includes('json_each')).length, statements }
}

async function analyzedBill(items: number) {
  const id = await seedBill({ aiProcessedAt: '2026-02-01T00:00:00.000Z' })
  const list = Array.from({ length: items }, (_, i) => ({ claim: `c${i}`, quote: `q${i}`, status: 'exact', claimAt: { start: 0, end: 1 } }))
  await env.DB.prepare('UPDATE bills SET claim_sources = ? WHERE id = ?').bind(JSON.stringify(list), id).run()
}

beforeEach(async () => {
  await resetDb()
  await applyMigrations()
})

describe('the cached counts', () => {
  it('computes once on a cold cache, and says when', async () => {
    await analyzedBill(2)
    const { db, scans } = counting()
    const snap = await cachedClaimSourceCounts(db, T0)
    expect(scans()).toBe(1)
    expect(snap.items.exact).toBe(2)
    expect(snap.computedAt).toBe('2026-03-01T12:00:00.000Z')
  })

  it('serves a second view inside the window without scanning again', async () => {
    await analyzedBill(2)
    const { db, scans } = counting()
    await cachedClaimSourceCounts(db, T0)
    const again = await cachedClaimSourceCounts(db, T0 + 5 * 60 * 1000)
    expect(scans()).toBe(1)
    expect(again.items.exact).toBe(2)
  })

  it('keeps showing when the counts were taken, so the age is the cache age', async () => {
    await analyzedBill(1)
    const { db } = counting()
    await cachedClaimSourceCounts(db, T0)
    const again = await cachedClaimSourceCounts(db, T0 + 10 * 60 * 1000)
    expect(again.computedAt).toBe('2026-03-01T12:00:00.000Z')
  })

  it('serves stale data inside the window rather than the newest', async () => {
    await analyzedBill(1)
    const { db } = counting()
    await cachedClaimSourceCounts(db, T0)
    await analyzedBill(4)
    expect((await cachedClaimSourceCounts(db, T0 + WINDOW_MS - 1)).items.exact).toBe(1)
  })

  it('recomputes once the window has passed', async () => {
    await analyzedBill(1)
    const { db, scans } = counting()
    await cachedClaimSourceCounts(db, T0)
    await analyzedBill(4)
    const later = await cachedClaimSourceCounts(db, T0 + WINDOW_MS)
    expect(scans()).toBe(2)
    expect(later.items.exact).toBe(5)
    expect(later.computedAt).toBe(new Date(T0 + WINDOW_MS).toISOString())
  })

  it('starts a new window after a recompute', async () => {
    await analyzedBill(1)
    const { db, scans } = counting()
    await cachedClaimSourceCounts(db, T0)
    await cachedClaimSourceCounts(db, T0 + WINDOW_MS)
    await cachedClaimSourceCounts(db, T0 + WINDOW_MS + 60_000)
    expect(scans()).toBe(2)
  })

  it('always reads the cut-off count fresh, since it is one cheap lookup', async () => {
    const { db, scans } = counting()
    expect((await cachedClaimSourceCounts(db, T0)).cutOffRetries).toBe(0)
    await recordClaimSourcesCutOff(db)
    await recordClaimSourcesCutOff(db)
    const snap = await cachedClaimSourceCounts(db, T0 + 60_000)
    expect(snap.cutOffRetries).toBe(2)
    expect(scans()).toBe(1)
  })

  it('recomputes when the cache row is damaged', async () => {
    await analyzedBill(1)
    await getDb(env.DB).insert(associationConfig).values({ key: 'claim_source_counts_cache', value: 'not json' })
    const { db, scans } = counting()
    const snap = await cachedClaimSourceCounts(db, T0)
    expect(scans()).toBe(1)
    expect(snap.items.exact).toBe(1)
    // and repaired it
    await cachedClaimSourceCounts(db, T0 + 60_000)
    expect(scans()).toBe(1)
  })

  it('recomputes when the cache claims to be from the future, as after a clock change', async () => {
    await analyzedBill(1)
    const { db, scans } = counting()
    await cachedClaimSourceCounts(db, T0 + 3 * WINDOW_MS)
    await cachedClaimSourceCounts(db, T0)
    expect(scans()).toBe(2)
  })

  it('keeps its cache in association_config, which no config endpoint or export serves', async () => {
    await analyzedBill(1)
    await cachedClaimSourceCounts(getDb(env.DB), T0)
    const row = await env.DB.prepare(`SELECT value FROM association_config WHERE key = 'claim_source_counts_cache'`).first<{ value: string }>()
    expect(row).not.toBeNull()
    expect(JSON.parse(row!.value)).toMatchObject({ computedAtMs: T0 })
  })

  it('carries no claim text, quote, or bill id in the cache', async () => {
    const id = await seedBill({ aiProcessedAt: '2026-02-01T00:00:00.000Z' })
    await env.DB.prepare('UPDATE bills SET claim_sources = ? WHERE id = ?')
      .bind(JSON.stringify([{ claim: 'Secret claim.', quote: 'Secret quote', status: 'exact', claimAt: { start: 0, end: 1 } }]), id).run()
    await cachedClaimSourceCounts(getDb(env.DB), T0)
    const row = await env.DB.prepare(`SELECT value FROM association_config WHERE key = 'claim_source_counts_cache'`).first<{ value: string }>()
    expect(row!.value).not.toContain('Secret')
    expect(row!.value).not.toContain(id)
  })
})
