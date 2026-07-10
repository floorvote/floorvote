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

    // In the worklist: keyword + analyzed (new_match_at) + no priority + not dismissed.
    await seedBill({ billNumber: 'IN 1', title: 'In worklist', matchType: 'keyword', newMatchAt: MATCH, relevanceScore: 80 })
    // Excluded: has a priority.
    await seedBill({ billNumber: 'PRI 2', title: 'Prioritized', matchType: 'keyword', newMatchAt: MATCH, priority: 'high', relevanceScore: 80 })
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
