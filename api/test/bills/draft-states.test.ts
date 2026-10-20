import { describe, it, expect, vi, beforeEach } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { clearDb, seedUser, seedSession } from '../helpers'
import { getDb } from '../../src/db/client'
import { bills } from '../../src/db/schema'
import { centralFetch } from '../../src/lib/centralFetch'

vi.mock('../../src/lib/centralFetch', () => ({
  centralFetch: vi.fn(),
}))

// GET /bills/draft-states is what the bills page's Add draft bill menu reads, in place of
// the full GET /bills/facets: just the states the tenant has bills in, with no counts.
describe('GET /api/bills/draft-states', () => {
  let adminToken: string
  let memberToken: string

  const get = (token?: string) =>
    SELF.fetch('https://x/api/bills/draft-states', token ? { headers: { Cookie: `session=${token}` } } : undefined)

  beforeEach(async () => {
    await clearDb()
    adminToken = await seedSession(await seedUser({ email: 'admin@x.com', role: 'admin' }))
    memberToken = await seedSession(await seedUser({ email: 'member@x.com', role: 'member' }))
    vi.mocked(centralFetch).mockReset()
  })

  it('lists each state once, sorted, with no counts', async () => {
    await getDb(env.DB).insert(bills).values([
      { id: 'a', billNumber: 'HB1', title: 'A', state: 'UT' },
      { id: 'b', billNumber: 'HB2', title: 'B', state: 'UT' },
      { id: 'c', billNumber: 'HB3', title: 'C', state: 'CO' },
      { id: 'd', billNumber: 'HB4', title: 'D', state: 'AZ' },
    ])
    const res = await get(adminToken)
    // Also proves the route is not captured by GET /bills/:id, which would answer 404.
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ states: ['AZ', 'CO', 'UT'] })
  })

  it('includes a state whose only bills are drafts', async () => {
    await getDb(env.DB).insert(bills).values([
      { id: 'a', billNumber: 'HB1', title: 'A', state: 'UT' },
      { id: 'b', billNumber: 'D1', title: 'Draft', state: 'NJ', isDraft: true },
    ])
    expect(await (await get(adminToken)).json()).toEqual({ states: ['NJ', 'UT'] })
  })

  it('leaves out the blank state a draft created without one carries', async () => {
    await getDb(env.DB).insert(bills).values([
      { id: 'a', billNumber: 'HB1', title: 'A', state: 'UT' },
      { id: 'b', billNumber: 'D1', title: 'Draft', state: '', isDraft: true },
    ])
    expect(await (await get(adminToken)).json()).toEqual({ states: ['UT'] })
  })

  it('answers an empty list for a tenant with no bills', async () => {
    expect(await (await get(adminToken)).json()).toEqual({ states: [] })
  })

  it('is admin only', async () => {
    await getDb(env.DB).insert(bills).values({ id: 'a', billNumber: 'HB1', title: 'A', state: 'UT' })
    expect((await get(memberToken)).status).toBe(403)
    expect((await get()).status).toBe(401)
  })

  it('stays cheap: no call to central and no read of the committee table', async () => {
    await getDb(env.DB).insert(bills).values({ id: 'a', billNumber: 'HB1', title: 'A', state: 'UT' })
    const sqls: string[] = []
    const realPrepare = env.DB.prepare.bind(env.DB)
    const spy = vi.spyOn(env.DB, 'prepare').mockImplementation((sql: string) => { sqls.push(sql); return realPrepare(sql) })
    const res = await get(adminToken)
    spy.mockRestore()
    expect(res.status).toBe(200)
    expect(centralFetch).not.toHaveBeenCalled()
    expect(sqls.some(s => /\bbills\b/i.test(s)), 'the spy saw no read of bills').toBe(true)
    expect(sqls.some(s => /bill_committees/i.test(s))).toBe(false)
  })
})
