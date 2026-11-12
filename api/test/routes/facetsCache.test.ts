import { describe, it, expect, beforeAll, vi } from 'vitest'
import { env } from 'cloudflare:test'
import { appFetch, seedUser, seedSession } from '../helpers'
import { seedFilterFixture } from './billFilterFixture'
import { FACETS_CACHE_TTL_SECONDS, facetsCacheKey, facetsCacheTtl } from '../../src/lib/facetsCache'

// A member's facets response is kept for a minute. On the largest instance one facets request cost about 1.2 s of
// D1 time, and a few page loads within ten seconds spent the database's budget so that every query failed (D1 7429).
// A reload within the minute answers from the cache and reads nothing. The cache is the member's own (the counts
// beside the facets are theirs), and a request that says Cache-Control: no-cache (the page, after its own edit) is
// counted afresh and replaces it.

type Facets = Record<string, unknown> & { status: Record<string, number>; myBillsCount: number }

// The shared test bindings turn the cache off (vitest.config.mts); these run with the deployed default.
const cacheOn = { ...env, FACETS_CACHE_TTL: undefined }

describe('GET /bills/facets, the per-member cache', () => {
  let token: string
  let ada: string

  beforeAll(async () => {
    ({ token, ada } = await seedFilterFixture())
  })

  async function facets(qs: string, opts: { cookie?: string; noCache?: boolean } = {}) {
    const headers: Record<string, string> = { Cookie: opts.cookie ?? `session=${token}` }
    if (opts.noCache) headers['Cache-Control'] = 'no-cache'
    const res = await appFetch(`http://localhost/api/bills/facets?${qs}`, { headers }, cacheOn)
    return { status: res.status, body: await res.json() as Facets }
  }

  /** The facet statements (counts) a request prepares, and its body. */
  async function counted(qs: string, opts: { cookie?: string; noCache?: boolean } = {}) {
    const seen: string[] = []
    const realPrepare = env.DB.prepare.bind(env.DB)
    const spy = vi.spyOn(env.DB, 'prepare').mockImplementation((sql: string) => { seen.push(sql); return realPrepare(sql) })
    try {
      const { status, body } = await facets(qs, opts)
      return { status, body, counts: seen.filter(s => /COUNT\(|SUM\(/i.test(s)).length }
    } finally {
      spy.mockRestore()
    }
  }

  const passedCount = async () => (await env.DB.prepare("SELECT COUNT(*) AS n FROM bills WHERE status = 'Passed'").first<{ n: number }>())!.n

  it('answers a repeat of the same request from the cache, reading no counts', async () => {
    const first = await counted('state=NJ')
    expect(first.status).toBe(200)
    expect(first.counts).toBeGreaterThan(0)
    const again = await counted('state=NJ')
    expect(again.counts).toBe(0)
    expect(again.body).toEqual(first.body)
  })

  it('keys the same filter in any parameter order alike', async () => {
    await counted('status=Passed&state=NJ')
    expect((await counted('state=NJ&status=Passed')).counts).toBe(0)
  })

  it('keeps each filter, and each omit or only, apart', async () => {
    const all = await counted('state=TX')
    const omitted = await counted('state=TX&omit=subject,committee')
    const only = await counted('state=TX&only=subject')
    expect([all.counts, omitted.counts, only.counts].every(n => n > 0)).toBe(true)
    expect(omitted.body).not.toHaveProperty('subject')
    expect(only.body).not.toHaveProperty('status')
  })

  it('never answers one member from another member\'s cache', async () => {
    await counted('state=UT')
    const other = await seedUser({ role: 'admin', email: 'other@example.com' })
    const cookie = `session=${await seedSession(other)}`
    expect((await counted('state=UT', { cookie })).counts).toBeGreaterThan(0)
  })

  it('serves the kept counts within the minute, and counts afresh on Cache-Control: no-cache, which replaces them', async () => {
    const before = (await facets('match=all')).body
    const passed = await passedCount()
    await env.DB.prepare("UPDATE bills SET status = 'Passed' WHERE status <> 'Passed' AND id = (SELECT id FROM bills WHERE status <> 'Passed' AND group_key IS NULL LIMIT 1)").run()
    expect(await passedCount()).toBe(passed + 1)
    // Within the minute a plain request is the kept one.
    expect((await facets('match=all')).body).toEqual(before)
    // The page's request after its own edit.
    const fresh = await counted('match=all', { noCache: true })
    expect(fresh.counts).toBeGreaterThan(0)
    expect(fresh.body.status).not.toEqual(before.status)
    // And it replaced the kept one.
    const after = await counted('match=all')
    expect(after.counts).toBe(0)
    expect(after.body).toEqual(fresh.body)
  })

  it('keeps a response for the TTL, and never an error', async () => {
    await facets('state=NJ&year=2026')
    const key = facetsCacheKey({ TENANT_ID: env.TENANT_ID }, ada, new URLSearchParams('year=2026&state=NJ'))
    const kept = await caches.default.match(key)
    expect(kept?.headers.get('Cache-Control')).toBe(`max-age=${FACETS_CACHE_TTL_SECONDS}`)
    expect(FACETS_CACHE_TTL_SECONDS).toBe(60)

    expect((await facets('omit=nope')).status).toBe(400)
    expect(await caches.default.match(facetsCacheKey({ TENANT_ID: env.TENANT_ID }, ada, new URLSearchParams('omit=nope')))).toBeUndefined()
  })

  it('is off at a TTL of 0, and reads FACETS_CACHE_TTL otherwise', async () => {
    expect(facetsCacheTtl({})).toBe(60)
    expect(facetsCacheTtl({ FACETS_CACHE_TTL: '0' })).toBe(0)
    expect(facetsCacheTtl({ FACETS_CACHE_TTL: '15' })).toBe(15)
    expect(facetsCacheTtl({ FACETS_CACHE_TTL: '-3' })).toBe(0)
    expect(facetsCacheTtl({ FACETS_CACHE_TTL: 'x' })).toBe(0)
    // The shared bindings' 0: a repeat is counted again.
    const off = async () => {
      const seen: string[] = []
      const realPrepare = env.DB.prepare.bind(env.DB)
      const spy = vi.spyOn(env.DB, 'prepare').mockImplementation((sql: string) => { seen.push(sql); return realPrepare(sql) })
      try {
        await appFetch('http://localhost/api/bills/facets?state=NJ&session=off', { headers: { Cookie: `session=${token}` } })
      } finally { spy.mockRestore() }
      return seen.filter(sql => /COUNT\(|SUM\(/i.test(sql)).length
    }
    expect(await off()).toBeGreaterThan(0)
    expect(await off()).toBeGreaterThan(0)
  })

  it('keeps each tenant\'s entries apart, since tenants of one zone share its cache', () => {
    const params = new URLSearchParams('state=NJ')
    const a = facetsCacheKey({ TENANT_ID: 'one' }, 'u1', params).url
    const b = facetsCacheKey({ TENANT_ID: 'two' }, 'u1', params).url
    expect(a).not.toBe(b)
    // Neither part can reach into another's path.
    expect(facetsCacheKey({ TENANT_ID: 'one/two' }, 'u1', params).url).not.toBe(facetsCacheKey({ TENANT_ID: 'one' }, 'two/u1', params).url)
  })

  it('answers the counts it computed when the cache will not keep them', async () => {
    const put = vi.spyOn(caches.default, 'put').mockRejectedValue(new Error('cache unavailable'))
    try {
      const { status, body } = await facets('state=NJ&year=2025')
      expect(status).toBe(200)
      expect(body.status).toBeDefined()
    } finally {
      put.mockRestore()
    }
  })
})
