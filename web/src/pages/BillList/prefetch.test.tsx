import { describe, it, expect, vi, beforeEach } from 'vitest'

const apiCalls: string[] = []
vi.mock('../../lib/api', () => ({
  apiFetch: async (path: string) => {
    apiCalls.push(path)
    if (path.startsWith('/bills?')) {
      return { bills: [{ id: 'b1', billNumber: 'HB 1', title: 'Primed Bill', state: 'RI', status: '2',
        session: '2025-2026', sessionId: null, yearStart: 2025, yearEnd: 2026, abstract: null, url: null,
        stateUrl: null, lastAction: 'x', lastActionDate: '2026-02-01', tenantSummary: null, tags: [],
        priority: null, matchType: 'keyword', position: null, relevanceScore: 80, aiProcessedAt: null,
        voteCounts: { support: 0, oppose: 0, neutral: 0 }, myVote: null, commentCount: 0, hasNote: false,
        hasComment: false, updatedAt: '2026-02-01 10:00:00', customFieldValues: {} }],
        pagination: { page: 1, pageSize: 100, total: 1, totalPages: 1 } }
    }
    return {}
  },
  ApiError: class extends Error {},
}))

import { prefetchBills } from './index'

beforeEach(() => { apiCalls.length = 0 })

describe('prefetchBills', () => {
  it('fetches the first page for a target URL so the list can hydrate from cache', async () => {
    await prefetchBills('/bills?status=2')
    expect(apiCalls.some(c => c === '/bills?page=1&pageSize=100&status=2')).toBe(true)
  })
})
