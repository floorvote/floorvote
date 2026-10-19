import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { resetDb, applyMigrations, appFetch, seedUser, seedSession, seedBill } from '../helpers'
import { getDb } from '../../src/db/client'
import { bills, memberVotes, notes } from '../../src/db/schema'
import { app } from '../../src/index'

// The four toggles of a bill filter (myBills, unvoted, newMatches, drafts) read one way: `1` or `true` turns one
// on, and anything else leaves it off. `unvoted` used to accept only `1` (#690), so `?unvoted=true` quietly
// returned every bill, and a bulk filter's `unvoted: true` selected every group.

type ListBody = { bills: Array<{ id: string; billNumber: string }>; pagination: { total: number } }

describe('the scope toggles read 1 and true alike', () => {
  let ada: string
  let adaToken: string
  let ben: string
  let benToken: string
  let a: string // Ada voted
  let b: string // Ben voted, and Ada noted
  let c: string // nobody voted, and a draft
  let d: string // nobody voted, and a new match no one has triaged

  const get = (token: string, path: string) => appFetch(`http://localhost/api${path}`, { headers: { Cookie: `session=${token}` } })
  async function numbers(token: string, qs: string): Promise<string[]> {
    const res = await get(token, `/bills?pageSize=200&${qs}`)
    expect(res.status).toBe(200)
    return ((await res.json()) as ListBody).bills.map(x => x.billNumber).sort()
  }
  const post = (token: string, path: string, body: object) => appFetch(`http://localhost/api/bills${path}`, {
    method: 'POST', headers: { Cookie: `session=${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  const ALL = ['HB 1', 'HB 2', 'HB 3', 'HB 4']

  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    ada = await seedUser({ role: 'admin', email: 'ada@example.com' })
    ben = await seedUser({ role: 'member', email: 'ben@example.com' })
    adaToken = await seedSession(ada)
    benToken = await seedSession(ben)
    a = await seedBill({ billNumber: 'HB 1', matchType: 'manual' })
    b = await seedBill({ billNumber: 'HB 2', matchType: 'manual' })
    c = await seedBill({ billNumber: 'HB 3', matchType: 'manual', isDraft: true })
    d = await seedBill({ billNumber: 'HB 4', matchType: 'keyword', newMatchAt: '2026-06-20 00:00:00', relevanceScore: 80 })
    const db = getDb(env.DB)
    await db.insert(memberVotes).values({ id: crypto.randomUUID(), userId: ada, billId: a, position: 'support' })
    await db.insert(memberVotes).values({ id: crypto.randomUUID(), userId: ben, billId: b, position: 'oppose' })
    await db.insert(notes).values({ id: crypto.randomUUID(), billId: b, userId: ada, content: 'a note' })
  })

  // What each toggle keeps for Ada, when it is on.
  const ON: Array<[string, string[]]> = [
    ['myBills', ['HB 1', 'HB 2']], // her vote on HB 1, her note on HB 2
    ['unvoted', ['HB 2', 'HB 3', 'HB 4']],
    ['newMatches', ['HB 4']],
    ['drafts', ['HB 3']],
  ]

  describe('GET /bills', () => {
    it.each(ON)('%s reads 1 and true alike, and keeps the same bills', async (key, expected) => {
      expect(await numbers(adaToken, `${key}=1`)).toEqual(expected)
      expect(await numbers(adaToken, `${key}=true`)).toEqual(expected)
    })

    it.each(ON.map(([key]) => [key]))('%s reads 0, false, an empty value, yes, TRUE, 2, and a look-alike key as off', async (key) => {
      for (const qs of [`${key}=0`, `${key}=false`, `${key}=`, `${key}=yes`, `${key}=TRUE`, `${key}=2`, `not${key}=1`]) {
        expect(await numbers(adaToken, qs), qs).toEqual(ALL)
      }
    })

    it('unvoted=true returns what unvoted=1 returns, the exact rows, in the same order', async () => {
      const one = await (await get(adaToken, '/bills?unvoted=1')).json()
      const word = await (await get(adaToken, '/bills?unvoted=true')).json()
      expect(word).toEqual(one)
      expect((word as ListBody).pagination.total).toBe(3)
    })

    it('takes the first of a repeated toggle, as for any single-valued key', async () => {
      expect(await numbers(adaToken, 'unvoted=0&unvoted=1')).toEqual(ALL)
      expect(await numbers(adaToken, 'unvoted=true&unvoted=0')).toEqual(['HB 2', 'HB 3', 'HB 4'])
    })

    it('combines unvoted=true with the other toggles', async () => {
      expect(await numbers(adaToken, 'unvoted=true&myBills=true')).toEqual(['HB 2'])
      expect(await numbers(adaToken, 'unvoted=true&drafts=true')).toEqual(['HB 3'])
      expect(await numbers(adaToken, 'unvoted=true&newMatches=true')).toEqual(['HB 4'])
    })

    it('reads the viewer\'s own votes, so unvoted=true differs between two members', async () => {
      expect(await numbers(benToken, 'unvoted=true')).toEqual(['HB 1', 'HB 3', 'HB 4'])
      expect(await numbers(adaToken, 'unvoted=true')).toEqual(['HB 2', 'HB 3', 'HB 4'])
    })
  })

  describe('GET /bills with the list cache on', () => {
    // The Workers Cache API outlives resetDb, so each test names its own tenant.
    const cached = (tenant: string) => async (token: string, qs: string) => {
      const res = await app.request(`/api/bills?${qs}`, { headers: { Cookie: `session=${token}` } }, { ...env, TENANT_ID: tenant, LIST_CACHE_TTL: '60' })
      expect(res.status).toBe(200)
      return ((await res.json()) as ListBody).bills.map(x => x.billNumber).sort()
    }

    it('bypasses the shared cache for unvoted=true, so two members each see their own unvoted set', async () => {
      const list = cached('tenant-unvoted-true')
      expect(await list(adaToken, 'unvoted=true')).toEqual(['HB 2', 'HB 3', 'HB 4'])
      expect(await list(benToken, 'unvoted=true')).toEqual(['HB 1', 'HB 3', 'HB 4'])
      expect(await list(adaToken, 'unvoted=true')).toEqual(['HB 2', 'HB 3', 'HB 4'])
    })

    it('bypasses the shared cache for myBills=true too', async () => {
      const list = cached('tenant-my-bills-true')
      expect(await list(adaToken, 'myBills=true')).toEqual(['HB 1', 'HB 2'])
      expect(await list(benToken, 'myBills=true')).toEqual(['HB 2'])
    })

    it('still serves the same page to both members for a request that is not per-user', async () => {
      const list = cached('tenant-shared')
      expect(await list(adaToken, 'unvoted=0')).toEqual(ALL)
      expect(await list(benToken, 'unvoted=false')).toEqual(ALL)
    })
  })

  describe('GET /bills/facets', () => {
    type Facets = Record<string, unknown>
    const facets = async (token: string, qs: string): Promise<Facets> => {
      const res = await get(token, `/bills/facets?${qs}`)
      expect(res.status).toBe(200)
      return await res.json() as Facets
    }

    it('unvoted=true returns the facets unvoted=1 returns', async () => {
      const one = await facets(adaToken, 'unvoted=1')
      expect(await facets(adaToken, 'unvoted=true')).toEqual(one)
      // Not the unfiltered facets: HB 1, which Ada voted on, is out of every count.
      expect(await facets(adaToken, '')).not.toEqual(one)
    })

    it.each(ON.map(([key]) => [key]))('%s: 1 and true return the same facets, and false the unfiltered ones', async (key) => {
      expect(await facets(adaToken, `${key}=true`)).toEqual(await facets(adaToken, `${key}=1`))
      expect(await facets(adaToken, `${key}=false`)).toEqual(await facets(adaToken, ''))
    })
  })

  describe('POST /bills/bulk-dismiss, which stamps the new matches of the selection', () => {
    // Every bill but HB 4 is not a new match, so a dismiss counts HB 4 only when the filter keeps it.
    const dismissed = async (filter: string) => {
      const res = await post(adaToken, '/bulk-dismiss', { filter })
      expect(res.status).toBe(200)
      return ((await res.json()) as { dismissed: number }).dismissed
    }
    const triaged = async (id: string) => (await getDb(env.DB).select().from(bills).all()).find(x => x.id === id)!.triagedAt

    it.each([['1'], ['true']])('a filter with unvoted=%s selects the unvoted groups (HB 4 is one)', async (v) => {
      expect(await dismissed(`unvoted=${v}`)).toBe(1)
      expect(await triaged(d)).not.toBeNull()
    })

    it.each([['0'], ['false'], ['']])('a filter with unvoted=%s applies no filter, and still reaches HB 4', async (v) => {
      expect(await dismissed(`unvoted=${v}`)).toBe(1)
    })

    it('a filter that unvoted excludes selects nothing: once Ada votes on HB 4, it is out of her unvoted groups', async () => {
      await getDb(env.DB).insert(memberVotes).values({ id: crypto.randomUUID(), userId: ada, billId: d, position: 'support' })
      for (const v of ['1', 'true']) expect(await dismissed(`unvoted=${v}`), v).toBe(0)
      expect(await triaged(d)).toBeNull()
    })
  })

  describe('POST /bills/bulk', () => {
    const edit = async (filter: string) => {
      const res = await post(adaToken, '/bulk', { filter, priority: 'high' })
      expect(res.status).toBe(200)
      return ((await res.json()) as { updated: number }).updated
    }

    it.each([['1'], ['true']])('a filter with unvoted=%s selects the same groups: 3 of the 4', async (v) => {
      expect(await edit(`unvoted=${v}`)).toBe(3)
      const rows = await getDb(env.DB).select().from(bills).all()
      expect(rows.filter(r => r.priority === 'high').map(r => r.billNumber).sort()).toEqual(['HB 2', 'HB 3', 'HB 4'])
    })

    it.each([['0'], ['false'], ['']])('a filter with unvoted=%s selects all 4 groups', async (v) => {
      expect(await edit(`unvoted=${v}`)).toBe(4)
    })

    it.each([['1'], ['true']])('a filter with myBills, newMatches, and drafts=%s reads each as on', async (v) => {
      expect(await edit(`myBills=${v}`)).toBe(2)
      expect(await edit(`newMatches=${v}`)).toBe(1)
      expect(await edit(`drafts=${v}`)).toBe(1)
    })

    it.each([['0'], ['false']])('a filter with myBills, newMatches, and drafts=%s selects all 4 groups', async (v) => {
      expect(await edit(`myBills=${v}`)).toBe(4)
      expect(await edit(`newMatches=${v}`)).toBe(4)
      expect(await edit(`drafts=${v}`)).toBe(4)
    })
  })

  describe('GET /bills/bulk-values', () => {
    const count = async (qs: string) => {
      const res = await get(adaToken, `/bills/bulk-values?${qs}`)
      expect(res.status).toBe(200)
      return ((await res.json()) as { count: number }).count
    }
    it('unvoted=1 and unvoted=true count the same groups, and unvoted=false counts them all', async () => {
      expect(await count('unvoted=1')).toBe(3)
      expect(await count('unvoted=true')).toBe(3)
      expect(await count('unvoted=false')).toBe(4)
      expect(await count('unvoted=')).toBe(4)
    })
  })
})
