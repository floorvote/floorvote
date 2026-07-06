import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { resetDb, applyMigrations, seedUser, seedSession, seedBill } from '../helpers'
import { getDb } from '../../src/db/client'
import { bills, memberVotes } from '../../src/db/schema'
import { eq } from 'drizzle-orm'
import { app } from '../../src/index'
import { cacheKeyFor, getCachedPage, putCachedPage, listCacheTtl } from '../../src/lib/listCache'

type ListBody = {
  bills: Array<{
    id: string
    billNumber: string
    title: string
    voteCounts: { support: number; oppose: number; neutral: number }
  }>
  pagination: { total: number }
}

// The Workers Cache API (caches.default) is NOT reset by resetDb between tests.
// Default-list cache keys exclude bill IDs, so without isolation a prior test's
// cached page could leak into the next. Give each test a unique TENANT_ID so its
// cache keys never collide with another test's.
function makeList(tenantId: string) {
  // Caching is OFF by default in prod; these tests exercise the cache path, so
  // enable it explicitly (LIST_CACHE_TTL: '60'). Individual calls can override
  // (e.g. the TTL=0 test) via envOverrides.
  return async function list(token: string, qs = '', envOverrides: Record<string, string> = {}) {
    const res = await app.request(
      `/api/bills${qs}`,
      { headers: { Cookie: `session=${token}` } },
      { ...env, TENANT_ID: tenantId, LIST_CACHE_TTL: '60', ...envOverrides },
    )
    expect(res.status).toBe(200)
    return (await res.json()) as ListBody
  }
}

describe('listCache helper (direct put/get)', () => {
  const baseParams = {
    statuses: [], priorities: [], positionValues: [], sessions: [], years: [],
    states: [], tagFilters: [], q: undefined, minRelevance: undefined,
    cfParamMap: {}, sort: 'default', dir: 'desc' as const, page: 1, pageSize: 50,
  }

  it('round-trips a stored page', async () => {
    const e = { TENANT_ID: 'test-org', LIST_CACHE_TTL: '60' }
    const key = cacheKeyFor(e, baseParams)
    await putCachedPage(e, key, { total: 3, billRows: [{ id: 'x' }] }, 60)
    const got = await getCachedPage(e, key)
    expect(got).toEqual({ total: 3, billRows: [{ id: 'x' }] })
  })

  it('TTL=0 disables: getter returns null and putter no-ops', async () => {
    const e = { TENANT_ID: 'test-org', LIST_CACHE_TTL: '0' }
    expect(listCacheTtl(e)).toBe(0)
    const key = cacheKeyFor(e, { ...baseParams, page: 99 })
    await putCachedPage(e, key, { total: 1, billRows: [] }, listCacheTtl(e))
    expect(await getCachedPage(e, key)).toBeNull()
  })

  it('defaults TTL to 0 (caching off) when unset/blank/invalid', () => {
    expect(listCacheTtl({})).toBe(0)
    expect(listCacheTtl({ LIST_CACHE_TTL: '' })).toBe(0)
    expect(listCacheTtl({ LIST_CACHE_TTL: 'nope' })).toBe(0)
    expect(listCacheTtl({ LIST_CACHE_TTL: '60' })).toBe(60)
  })

  it('normalizes multi-value filter order into the same key', () => {
    const e = { TENANT_ID: 'test-org' }
    const k1 = cacheKeyFor(e, { ...baseParams, statuses: ['Passed', 'Introduced'] })
    const k2 = cacheKeyFor(e, { ...baseParams, statuses: ['Introduced', 'Passed'] })
    expect(k1.url).toBe(k2.url)
  })

  it('scopes the key per tenant', () => {
    const k1 = cacheKeyFor({ TENANT_ID: 'tenant-a' }, baseParams)
    const k2 = cacheKeyFor({ TENANT_ID: 'tenant-b' }, baseParams)
    expect(k1.url).not.toBe(k2.url)
  })
})

describe('GET /bills default-list caching', () => {
  let token: string
  let userId: string
  let list: ReturnType<typeof makeList>

  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    list = makeList(`cache-test-${crypto.randomUUID()}`)
    userId = await seedUser()
    token = await seedSession(userId)
    await seedBill({ billNumber: 'HB 1', title: 'Election Act', priority: 'high', status: 'Introduced' })
    await seedBill({ billNumber: 'SB 2', title: 'Voter ID Act', priority: 'low', status: 'Passed' })
  })

  it('serves the second identical default request from cache (shared rows stale, enrichment fresh)', async () => {
    const first = await list(token)
    expect(first.bills).toHaveLength(2)
    const hb1 = first.bills.find(b => b.billNumber === 'HB 1')!
    expect(hb1.title).toBe('Election Act')
    expect(hb1.voteCounts).toEqual({ support: 0, oppose: 0, neutral: 0 })

    const db = getDb(env.DB)
    // Mutate the SHARED bill data directly: a cached response must NOT reflect this.
    await db.update(bills).set({ title: 'CHANGED TITLE' }).where(eq(bills.id, hb1.id))
    // Cast a vote: enrichment is recomputed fresh, so this MUST show up.
    await db.insert(memberVotes).values({
      id: crypto.randomUUID(), userId, billId: hb1.id, position: 'support',
    })

    const second = await list(token)
    const hb1b = second.bills.find(b => b.billNumber === 'HB 1')!
    // Cached shared rows: title unchanged.
    expect(hb1b.title).toBe('Election Act')
    // Fresh enrichment: vote count reflects the new vote.
    expect(hb1b.voteCounts.support).toBe(1)
  })

  it('uses a distinct cache key for a different sort (not served the default cached rows)', async () => {
    // Prime the default cache.
    await list(token)
    // Add a third bill AFTER priming default. A different sort key must miss and
    // re-query, so it sees all three bills; default would still show two.
    await seedBill({ billNumber: 'HB 3', title: 'Third Bill', priority: 'medium', status: 'Introduced' })

    const sorted = await list(token, '?sort=bill&dir=asc')
    expect(sorted.bills).toHaveLength(3)

    // Default is still cached → still shows the original two.
    const def = await list(token)
    expect(def.bills).toHaveLength(2)
  })

  it('uses a distinct cache key when a filter is applied', async () => {
    await list(token)
    await seedBill({ billNumber: 'HB 9', title: 'High Bill', priority: 'high', status: 'Introduced' })

    // Filtered request is a different key → fresh → sees the new high-priority bill.
    const filtered = await list(token, '?priority=high')
    expect(filtered.bills.map(b => b.billNumber).sort()).toEqual(['HB 1', 'HB 9'])
  })

  it('bypasses the cache for myBills=1 (always reflects current data)', async () => {
    const db = getDb(env.DB)
    // Prime default cache (2 bills, none are "mine").
    await list(token)

    // myBills with no interactions → empty.
    const empty = await list(token, '?myBills=1')
    expect(empty.bills).toHaveLength(0)

    // Interact, then myBills must reflect it immediately (no cached empty result).
    const all = await list(token, '?priority=high')
    const billId = all.bills[0].id
    await db.insert(memberVotes).values({
      id: crypto.randomUUID(), userId, billId, position: 'oppose',
    })
    const mine = await list(token, '?myBills=1')
    expect(mine.bills.map(b => b.id)).toContain(billId)
  })

  it('bypasses the cache for unvoted=1 (always reflects current votes)', async () => {
    const db = getDb(env.DB)
    const before = await list(token, '?unvoted=1')
    expect(before.bills).toHaveLength(2)

    const votedId = before.bills[0].id
    await db.insert(memberVotes).values({
      id: crypto.randomUUID(), userId, billId: votedId, position: 'support',
    })
    const after = await list(token, '?unvoted=1')
    // Voted bill drops out — proves no cached set was reused.
    expect(after.bills.map(b => b.id)).not.toContain(votedId)
    expect(after.bills).toHaveLength(1)
  })

  it('LIST_CACHE_TTL=0 disables caching — every request re-queries shared rows', async () => {
    const first = await list(token, '', { LIST_CACHE_TTL: '0' })
    const hb1 = first.bills.find(b => b.billNumber === 'HB 1')!

    const db = getDb(env.DB)
    await db.update(bills).set({ title: 'NOW FRESH' }).where(eq(bills.id, hb1.id))

    const second = await list(token, '', { LIST_CACHE_TTL: '0' })
    const hb1b = second.bills.find(b => b.billNumber === 'HB 1')!
    // No caching → shared rows reflect the direct mutation.
    expect(hb1b.title).toBe('NOW FRESH')
  })
})
