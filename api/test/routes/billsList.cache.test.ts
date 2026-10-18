import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { resetDb, applyMigrations, seedUser, seedSession, seedBill } from '../helpers'
import { getDb } from '../../src/db/client'
import { bills, memberVotes, officialPositions, billSubjects, customFieldDefinitions, billCustomFieldValues } from '../../src/db/schema'
import { eq } from 'drizzle-orm'
import { app } from '../../src/index'
import { cacheKeyFor, getCachedPage, putCachedPage, listCacheTtl } from '../../src/lib/listCache'
import { BILL_FILTER_DEFS, EMPTY_BILL_FILTER, parseBillFilter } from '../../../shared/billFilter'

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
    filter: EMPTY_BILL_FILTER, sort: 'default', dir: 'desc' as const, page: 1, pageSize: 50,
  }
  const withFilter = (qs: string) => ({ ...baseParams, filter: parseBillFilter(qs) })
  const keyOf = (qs: string) => cacheKeyFor({ TENANT_ID: 'test-org' }, withFilter(qs)).url

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
    const k1 = cacheKeyFor(e, withFilter('status=Passed&status=Introduced'))
    const k2 = cacheKeyFor(e, withFilter('status=Introduced&status=Passed'))
    expect(k1.url).toBe(k2.url)
  })

  it('scopes the key per tenant', () => {
    const k1 = cacheKeyFor({ TENANT_ID: 'tenant-a' }, baseParams)
    const k2 = cacheKeyFor({ TENANT_ID: 'tenant-b' }, baseParams)
    expect(k1.url).not.toBe(k2.url)
  })

  it('gives params that differ only in the match mode different keys (#687)', () => {
    expect(keyOf('status=Passed&priority=high&match=any')).not.toBe(keyOf('status=Passed&priority=high'))
  })

  it('gives two equal bill filters the same key, however their query strings were written', () => {
    expect(keyOf('priority=high&status=Passed&match=any')).toBe(keyOf('match=any&status=Passed&priority=high'))
    expect(keyOf('field.area=b&field.area=a&field.zone=x')).toBe(keyOf('field.zone=x&field.area=a&field.area=b'))
    expect(keyOf('subject=NJ:Taxes&subject=UT:Elections')).toBe(keyOf('subject=UT:Elections&subject=NJ:Taxes'))
    expect(keyOf('status=Passed&match=all')).toBe(keyOf('status=Passed'))
  })

  it('leaves no filter out of the key: every filter the shared module names changes it when it is set', () => {
    // One value per filter, taken from the module's own definitions so a filter added to it must be added here too.
    const SET: Record<string, string> = {
      status: 'status=Passed', stage: 'stage=passed', year: 'year=2026', sessionName: 'sessionName=2026', state: 'state=NJ',
      position: 'position=Support', priority: 'priority=high', tag: 'tag=Clerk', subject: 'subject=UT:Elections',
      minRelevance: 'minRelevance=5', search: 'search=election', myBills: 'myBills=1', unvoted: 'unvoted=1', newMatches: 'newMatches=1',
      drafts: 'drafts=1', match: 'match=any', field: 'field.area=North',
    }
    expect(Object.keys(SET).sort()).toEqual(BILL_FILTER_DEFS.map(d => d.name).sort())
    const unfiltered = keyOf('')
    for (const [name, qs] of Object.entries(SET)) {
      expect(keyOf(qs), `the key with ${name} set`).not.toBe(unfiltered)
      expect(parseBillFilter(qs)[name as keyof typeof EMPTY_BILL_FILTER], `${qs} sets ${name}`).not.toEqual(EMPTY_BILL_FILTER[name as keyof typeof EMPTY_BILL_FILTER])
    }
    // And each one's key is its own.
    const keys = new Set(Object.values(SET).map(keyOf))
    expect(keys.size).toBe(Object.keys(SET).length)
  })

  it('gives a different page, sort, direction, and page size a different key', () => {
    const k = (over: Partial<typeof baseParams>) => cacheKeyFor({ TENANT_ID: 'test-org' }, { ...baseParams, ...over }).url
    const base = k({})
    for (const over of [{ page: 2 }, { pageSize: 25 }, { sort: 'bill' }, { dir: 'asc' as const }]) expect(k(over)).not.toBe(base)
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

  it('serves the second identical default request from cache (page stale, rows and enrichment fresh)', async () => {
    const first = await list(token)
    expect(first.bills).toHaveLength(2)
    const hb1 = first.bills.find(b => b.billNumber === 'HB 1')!
    expect(hb1.title).toBe('Election Act')
    expect(hb1.voteCounts).toEqual({ support: 0, oppose: 0, neutral: 0 })

    const db = getDb(env.DB)
    // A bill added after the page was cached must NOT show up: the page is the cached part.
    await seedBill({ billNumber: 'HB 3', title: 'Third Bill', priority: 'medium', status: 'Introduced' })
    // What the page's bills show is read fresh, so a change to one does.
    await db.update(bills).set({ title: 'CHANGED TITLE' }).where(eq(bills.id, hb1.id))
    // Cast a vote: enrichment is recomputed fresh, so this MUST show up.
    await db.insert(memberVotes).values({
      id: crypto.randomUUID(), userId, billId: hb1.id, position: 'support',
    })

    const second = await list(token)
    expect(second.bills.map(b => b.billNumber).sort()).toEqual(['HB 1', 'SB 2'])
    expect(second.pagination.total).toBe(2)
    const hb1b = second.bills.find(b => b.billNumber === 'HB 1')!
    expect(hb1b.title).toBe('CHANGED TITLE')
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

  // The key is the whole bill filter, so a request that sets a filter never reads the page of one that doesn't (#687).
  describe('a cache entry belongs to one bill filter', () => {
    it('does not serve a match=any request the page of the same filters that must all match', async () => {
      const all = await list(token, '?status=Passed&priority=high')
      expect(all.pagination.total).toBe(0)
      const any = await list(token, '?status=Passed&priority=high&match=any')
      expect(any.pagination.total).toBe(2)
      expect(any.bills.map(b => b.billNumber).sort()).toEqual(['HB 1', 'SB 2'])
    })

    it('does not serve a request that must all match the page of match=any, the other way round', async () => {
      const any = await list(token, '?status=Passed&priority=high&match=any')
      expect(any.pagination.total).toBe(2)
      const all = await list(token, '?status=Passed&priority=high')
      expect(all.pagination.total).toBe(0)
      expect(all.bills).toEqual([])
    })

    it('serves a repeat of a match=any request from its own entry', async () => {
      await list(token, '?status=Passed&priority=high&match=any')
      await seedBill({ billNumber: 'HB 3', title: 'Third Bill', priority: 'high', status: 'Introduced' })
      const again = await list(token, '?status=Passed&priority=high&match=any')
      expect(again.pagination.total).toBe(2)
    })

    it('shares an entry between two orders of the same picks', async () => {
      await list(token, '?status=Passed&status=Introduced')
      await seedBill({ billNumber: 'HB 3', title: 'Third Bill', status: 'Introduced' })
      const flipped = await list(token, '?status=Introduced&status=Passed')
      expect(flipped.pagination.total).toBe(2)
    })

    // Each filter: prime the page of the list with no filter, add a bill only that filter keeps, and ask for it. It is
    // served fresh only when the filter is in the key.
    const anchor = { billNumber: 'ZZ 9', title: 'Zebra Act' }
    const KEPT_BY: Array<[string, () => Promise<unknown>]> = [
      ['status=Vetoed', () => seedBill({ ...anchor, status: 'Vetoed' })],
      ['stage=vetoed', () => seedBill({ ...anchor, statusStage: 'vetoed' })],
      ['year=2031', () => seedBill({ ...anchor, yearStart: 2031 })],
      ['sessionName=2031', () => seedBill({ ...anchor, session: '2031' })],
      ['state=ZZ', () => seedBill({ ...anchor, state: 'ZZ' })],
      ['priority=medium', () => seedBill({ ...anchor, priority: 'medium' })],
      ['tag=Clerk', () => seedBill({ ...anchor, tags: ['Clerk'] })],
      ['minRelevance=9', () => seedBill({ ...anchor, relevanceScore: 9 })],
      ['search=zebra', () => seedBill(anchor)],
      ['drafts=1', () => seedBill({ ...anchor, isDraft: true })],
      ['position=Oppose', async () => {
        const id = await seedBill(anchor)
        await getDb(env.DB).insert(officialPositions).values({ id: 'p1', billId: id, position: 'Oppose', setBy: userId })
      }],
      ['subject=ZZ:Parks', async () => {
        const id = await seedBill(anchor)
        await getDb(env.DB).insert(billSubjects).values({ billId: id, subjectName: 'Parks', state: 'ZZ' })
      }],
      ['field.area=North', async () => {
        const db = getDb(env.DB)
        await db.insert(customFieldDefinitions).values({ id: 'cf-area', name: 'Area', slug: 'area', type: 'dropdown', options: JSON.stringify(['North']), multiple: false })
        const id = await seedBill(anchor)
        await db.insert(billCustomFieldValues).values({ billId: id, fieldId: 'cf-area', value: 'North', setBy: userId })
      }],
    ]
    for (const [qs, seed] of KEPT_BY) {
      it(`does not serve ${qs} the page of the list with no filter`, async () => {
        const unfiltered = await list(token)
        expect(unfiltered.pagination.total).toBe(2)
        await seed()
        const filtered = await list(token, `?${qs}`)
        expect(filtered.bills.map(b => b.billNumber)).toEqual(['ZZ 9'])
      })
    }
  })
})
