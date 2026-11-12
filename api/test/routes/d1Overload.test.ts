import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest'
import { env } from 'cloudflare:test'
import { appFetch } from '../helpers'
import { seedFilterFixture } from './billFilterFixture'
import { facetsCacheKey } from '../../src/lib/facetsCache'
import { cacheKeyFor } from '../../src/lib/listCache'
import { parseBillFilter } from '../../../shared/billFilter'

// When D1 answers "overloaded" (error 7429), GET /bills/facets and GET /bills answer 503 with Retry-After: 10 and a
// JSON body naming the overload, so the page can say so and try again; any other database failure stays a 500. The
// 503 is an answer about this moment, so neither response cache may keep it.

// Drizzle wraps a D1 error as "Failed query: <sql>", with D1's own reason on `.cause`.
const overload = () => new Error('Failed query: select 1', {
  cause: new Error('D1_ERROR: D1 DB is overloaded. Too many resources consumed within a 10 second window.: SQLITE_ERROR'),
})

/** Every statement that reads the bills table throws `error`; the session and user lookups still answer. */
function failBillReads(error: Error) {
  const realPrepare = env.DB.prepare.bind(env.DB)
  return vi.spyOn(env.DB, 'prepare').mockImplementation((sql: string) => {
    if (/\bFROM bills\b|\bbills AS\b|\bFROM "bills"\b/i.test(sql)) throw error
    return realPrepare(sql)
  })
}

const cachesOn = { ...env, FACETS_CACHE_TTL: undefined, LIST_CACHE_TTL: '60' }

describe('D1 overload on the bill routes', () => {
  let token: string

  beforeAll(async () => {
    ({ token } = await seedFilterFixture())
  })
  afterEach(() => { vi.restoreAllMocks() })

  const get = (path: string, bindings: typeof env = cachesOn) =>
    appFetch(`http://localhost/api${path}`, { headers: { Cookie: `session=${token}` } }, bindings)

  for (const path of ['/bills/facets', '/bills/facets?omit=subject,committee', '/bills/facets?only=subject,committee', '/bills?page=1&pageSize=25']) {
    it(`answers GET ${path} with a 503, Retry-After: 10, and a body naming the overload`, async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      failBillReads(overload())
      const res = await get(path)
      expect(res.status).toBe(503)
      expect(res.headers.get('Retry-After')).toBe('10')
      expect(res.headers.get('Content-Type')).toContain('application/json')
      expect(await res.json()).toMatchObject({ error: 'database_overloaded' })
    })

    it(`still answers GET ${path} with a 500 for any other database error`, async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      failBillReads(new Error('Failed query: select 1', { cause: new Error('D1_ERROR: no such column: nope: SQLITE_ERROR') }))
      const res = await get(path)
      expect(res.status).toBe(500)
      expect(res.headers.get('Retry-After')).toBeNull()
      expect(await res.json()).toEqual({ error: 'internal_error' })
    })
  }

  it('does not keep a 503 in the facets cache: the next request, once the database answers, counts and succeeds', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const spy = failBillReads(overload())
    expect((await get('/bills/facets?state=NJ')).status).toBe(503)
    spy.mockRestore()
    const key = facetsCacheKey(cachesOn, (await env.DB.prepare('SELECT id FROM users LIMIT 1').first<{ id: string }>())!.id, new URLSearchParams('state=NJ'))
    expect(await caches.default.match(key)).toBeUndefined()
    const again = await get('/bills/facets?state=NJ')
    expect(again.status).toBe(200)
    expect(again.headers.get('Retry-After')).toBeNull()
  })

  it('does not keep a 503 in the list cache: the next request, once the database answers, lists', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const spy = failBillReads(overload())
    expect((await get('/bills?page=1&pageSize=25')).status).toBe(503)
    spy.mockRestore()
    const key = cacheKeyFor(cachesOn, { filter: parseBillFilter(new URLSearchParams()), sort: 'default', dir: 'desc', page: 1, pageSize: 25 })
    const hit = await caches.default.match(key)
    expect(hit === undefined || hit.status === 200).toBe(true)
    const again = await get('/bills?page=1&pageSize=25')
    expect(again.status).toBe(200)
  })
})
