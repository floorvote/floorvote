import { describe, it, expect, beforeEach } from 'vitest'
import { SELF } from 'cloudflare:test'
import { resetDb, applyMigrations, seedUser, seedSession, seedBill } from '../helpers'

describe('Tracked-first query optimization', () => {
  let token: string

  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    const userId = await seedUser({ role: 'member' })
    token = await seedSession(userId)
  })

  async function fetchBills(qs = ''): Promise<{ bills: Array<{ id: string; billNumber: string }>; pagination: { total: number; page: number; totalPages: number } }> {
    const res = await SELF.fetch(`http://localhost/api/bills?${qs}`, {
      headers: { Cookie: `session=${token}` },
    })
    return res.json() as any
  }

  it('default sort returns tracked bills before untracked (fast path)', async () => {
    const cy = new Date().getUTCFullYear()
    await seedBill({ billNumber: 'TRACKED-1', matchType: 'keyword', priority: 'high', yearStart: cy, yearEnd: cy })
    await seedBill({ billNumber: 'TRACKED-2', matchType: 'manual', priority: 'low', yearStart: cy, yearEnd: cy })
    await seedBill({ billNumber: 'STUB-1', matchType: null, yearStart: cy, yearEnd: cy })

    const data = await fetchBills()
    expect(data.pagination.total).toBe(3)
    const numbers = data.bills.map(b => b.billNumber)
    expect(numbers.indexOf('TRACKED-1')).toBeLessThan(numbers.indexOf('STUB-1'))
    expect(numbers.indexOf('TRACKED-2')).toBeLessThan(numbers.indexOf('STUB-1'))
  })

  it('priority desc uses fast path when page is within tracked territory', async () => {
    const cy = new Date().getUTCFullYear()
    await seedBill({ billNumber: 'HIGH', matchType: 'keyword', priority: 'high', yearStart: cy, yearEnd: cy })
    await seedBill({ billNumber: 'MED', matchType: 'keyword', priority: 'medium', yearStart: cy, yearEnd: cy })
    await seedBill({ billNumber: 'STUB', matchType: null, yearStart: cy, yearEnd: cy })

    const data = await fetchBills('sort=priority&dir=desc&pageSize=2')
    expect(data.pagination.total).toBe(3)
    expect(data.bills).toHaveLength(2)
    expect(data.bills.every(b => b.billNumber !== 'STUB')).toBe(true)
  })

  it('non-optimizable sort returns all bills in correct order', async () => {
    await seedBill({ billNumber: 'A100', matchType: 'keyword', status: 'Passed' })
    await seedBill({ billNumber: 'B200', matchType: null, status: 'Introduced' })

    const data = await fetchBills('sort=bill&dir=asc')
    expect(data.pagination.total).toBe(2)
    expect(data.bills[0].billNumber).toBe('A100')
    expect(data.bills[1].billNumber).toBe('B200')
  })

  it('boundary page falls back to normal path', async () => {
    const cy = new Date().getUTCFullYear()
    // 3 tracked + 2 stubs, pageSize=2 → page 2 spans the boundary
    await seedBill({ billNumber: 'T1', matchType: 'keyword', priority: 'high', yearStart: cy, yearEnd: cy })
    await seedBill({ billNumber: 'T2', matchType: 'keyword', priority: 'medium', yearStart: cy, yearEnd: cy })
    await seedBill({ billNumber: 'T3', matchType: 'keyword', priority: 'low', yearStart: cy, yearEnd: cy })
    await seedBill({ billNumber: 'S1', matchType: null, yearStart: cy, yearEnd: cy })
    await seedBill({ billNumber: 'S2', matchType: null, yearStart: cy, yearEnd: cy })

    const page2 = await fetchBills('pageSize=2&page=2')
    expect(page2.pagination.total).toBe(5)
    expect(page2.bills).toHaveLength(2)
    // No duplicates with page 1
    const page1 = await fetchBills('pageSize=2&page=1')
    const page1Ids = page1.bills.map(b => b.id)
    const page2Ids = page2.bills.map(b => b.id)
    expect(page1Ids.filter(id => page2Ids.includes(id))).toHaveLength(0)
  })

  it('search with few tracked matches falls back to normal path', async () => {
    await seedBill({ billNumber: 'HB 100', title: 'Election Reform', matchType: 'keyword' })
    await seedBill({ billNumber: 'HB 200', title: 'Election Procedures', matchType: null })

    const data = await fetchBills('q=Election')
    expect(data.pagination.total).toBe(2)
    expect(data.bills).toHaveLength(2)
  })

  it('relevance desc uses fast path', async () => {
    const cy = new Date().getUTCFullYear()
    await seedBill({ billNumber: 'REL-HIGH', matchType: 'keyword', relevanceScore: 9, yearStart: cy, yearEnd: cy })
    await seedBill({ billNumber: 'REL-LOW', matchType: 'keyword', relevanceScore: 3, yearStart: cy, yearEnd: cy })
    await seedBill({ billNumber: 'STUB', matchType: null, yearStart: cy, yearEnd: cy })

    const data = await fetchBills('sort=relevance&dir=desc')
    expect(data.pagination.total).toBe(3)
    expect(data.bills[0].billNumber).toBe('REL-HIGH')
  })
})

describe('Facets always reflect all bills', () => {
  let token: string

  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    const userId = await seedUser({ role: 'member' })
    token = await seedSession(userId)
  })

  it('facet counts include both tracked and untracked bills', async () => {
    await seedBill({ billNumber: 'HB 1', matchType: 'keyword', status: 'Passed', priority: 'high' })
    await seedBill({ billNumber: 'HB 2', matchType: null, status: 'Passed' })
    await seedBill({ billNumber: 'HB 3', matchType: null, status: 'Introduced' })

    const res = await SELF.fetch('http://localhost/api/bills/facets', {
      headers: { Cookie: `session=${token}` },
    })
    const facets = await res.json() as Record<string, Record<string, number>>
    const passedCount = facets.status?.['Passed'] ?? 0
    expect(passedCount).toBe(2)
  })
})
