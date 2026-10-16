import { describe, it, expect, beforeEach } from 'vitest'
import { SELF } from 'cloudflare:test'
import { resetDb, applyMigrations, seedUser, seedSession, seedBill } from '../helpers'

type ListResp = { bills: { id: string; billNumber: string }[] }
type Facets = { newMatchesCount: number }

const MATCH = '2026-06-20 00:00:00'

describe('GET /bills?newMatches=1 — worklist predicate', () => {
  let adminToken: string

  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    const adminId = await seedUser({ role: 'admin', email: 'admin@example.com' })
    adminToken = await seedSession(adminId)

    // In the worklist: keyword + analyzed (new_match_at) + not yet triaged (triaged_at IS NULL) + at/above the relevance threshold.
    await seedBill({ billNumber: 'IN 1', title: 'In worklist', matchType: 'keyword', newMatchAt: MATCH, relevanceScore: 80 })
    // Excluded: prioritized bills are latched as triaged.
    await seedBill({ billNumber: 'PRI 2', title: 'Prioritized', matchType: 'keyword', newMatchAt: MATCH, priority: 'high', triagedAt: MATCH, relevanceScore: 80 })
    // Excluded: dismissed.
    await seedBill({ billNumber: 'DIS 3', title: 'Dismissed', matchType: 'keyword', newMatchAt: MATCH, triagedAt: MATCH, relevanceScore: 80 })
    // Excluded: manual match.
    await seedBill({ billNumber: 'MAN 4', title: 'Manual', matchType: 'manual', newMatchAt: MATCH, relevanceScore: 80 })
    // Excluded: not yet analyzed (no new_match_at).
    await seedBill({ billNumber: 'STB 5', title: 'Stub', matchType: 'keyword', newMatchAt: null, relevanceScore: 80 })
  })

  it('returns only un-triaged analyzed keyword bills', async () => {
    const res = await SELF.fetch('http://localhost/api/bills?newMatches=1', {
      headers: { Cookie: `session=${adminToken}` },
    })
    expect(res.status).toBe(200)
    const body = await res.json() as ListResp
    expect(body.bills.map(b => b.billNumber).sort()).toEqual(['IN 1'])
  })

  it('respects the relevance threshold', async () => {
    // Raise threshold to 50 and add a sub-threshold match.
    const { getDb } = await import('../../src/db/client')
    const { env } = await import('cloudflare:test')
    const { associationConfig } = await import('../../src/db/schema')
    await getDb(env.DB).insert(associationConfig).values({ key: 'new_match_min_relevance', value: '50' })
    await seedBill({ billNumber: 'LOW 6', title: 'Low relevance', matchType: 'keyword', newMatchAt: MATCH, relevanceScore: 20 })

    const res = await SELF.fetch('http://localhost/api/bills?newMatches=1', {
      headers: { Cookie: `session=${adminToken}` },
    })
    const body = await res.json() as ListResp
    expect(body.bills.map(b => b.billNumber).sort()).toEqual(['IN 1']) // LOW 6 excluded
  })

  it('facets expose newMatchesCount for admins', async () => {
    const res = await SELF.fetch('http://localhost/api/bills/facets', {
      headers: { Cookie: `session=${adminToken}` },
    })
    const body = await res.json() as Facets
    expect(body.newMatchesCount).toBe(1)
  })

  it('facets report newMatchesCount 0 for members', async () => {
    const memberId = await seedUser({ role: 'member', email: 'm@example.com' })
    const memberToken = await seedSession(memberId)
    const res = await SELF.fetch('http://localhost/api/bills/facets', {
      headers: { Cookie: `session=${memberToken}` },
    })
    const body = await res.json() as Facets
    expect(body.newMatchesCount).toBe(0)
  })
})

// #364: provenance only decides what reaches the digest (and feed). The triage
// list, its facet count, and the sidebar chip still show bulk matches.
describe('the triage list and chip show bulk and routine matches alike', () => {
  let adminToken: string

  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    const adminId = await seedUser({ role: 'admin', email: 'admin@example.com' })
    adminToken = await seedSession(adminId)
    await seedBill({ billNumber: 'RT 1', matchType: 'keyword', newMatchAt: MATCH, relevanceScore: 8, matchProvenance: 'routine' })
    await seedBill({ billNumber: 'BK 2', matchType: 'keyword', newMatchAt: MATCH, relevanceScore: 8, matchProvenance: 'bulk' })
    await seedBill({ billNumber: 'OLD 3', matchType: 'keyword', newMatchAt: MATCH, relevanceScore: 8, matchProvenance: null })
  })

  const get = async <T>(path: string) =>
    (await SELF.fetch(`http://localhost${path}`, { headers: { Cookie: `session=${adminToken}` } })).json() as Promise<T>

  it('lists every new match', async () => {
    const body = await get<ListResp>('/api/bills?newMatches=1')
    expect(body.bills.map(b => b.billNumber).sort()).toEqual(['BK 2', 'OLD 3', 'RT 1'])
  })

  it('counts every new match in the facets and the chip', async () => {
    expect((await get<Facets>('/api/bills/facets')).newMatchesCount).toBe(3)
    expect((await get<{ newMatchesCount: number }>('/api/stats')).newMatchesCount).toBe(3)
  })
})
