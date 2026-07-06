import { describe, it, expect, beforeAll } from 'vitest'
import { createOpenStatesProvider } from '../../src/providers/openstates'
import type { NormalizedBillStub, NormalizedBill, NormalizedSession } from '../../src/providers/types'

const apiKey = process.env.OPENSTATES_API_KEY ?? ''
const hasKey = apiKey.length > 0

// Known RI 2026 bill — stable fixture for detail tests
const KNOWN_BILL_ID = 'ocd-bill/5cf3cc87-1b4e-414b-9493-d091282d1bf3'
// Known RI 2025 bill with votes
const KNOWN_BILL_WITH_VOTES_ID = 'ocd-bill/5189fad8-9357-42c8-b5a4-39b686c5e2bc'

function assertBillStubShape(bill: NormalizedBillStub) {
  expect(typeof bill.id).toBe('string')
  expect(bill.id).toMatch(/^ocd-bill\//)
  expect(typeof bill.state).toBe('string')
  expect(bill.state).toHaveLength(2)
  expect(typeof bill.session).toBe('string')
  expect(bill.session.length).toBeGreaterThan(0)
  expect(typeof bill.number).toBe('string')
  expect(typeof bill.title).toBe('string')
  expect(bill.abstract === null || typeof bill.abstract === 'string').toBe(true)
  const validStatuses = ['introduced', 'in_committee', 'passed_lower', 'passed_upper', 'passed', 'enacted', 'vetoed', 'failed', 'unknown']
  expect(validStatuses).toContain(bill.status)
  expect(bill.statusDate === null || typeof bill.statusDate === 'string').toBe(true)
  expect(bill.lastAction === null || typeof bill.lastAction === 'string').toBe(true)
  expect(bill.lastActionDate === null || typeof bill.lastActionDate === 'string').toBe(true)
  expect(typeof bill.url).toBe('string')
  expect(bill.stateUrl === null || typeof bill.stateUrl === 'string').toBe(true)
  expect(Array.isArray(bill.sponsors)).toBe(true)
  expect(Array.isArray(bill.versions)).toBe(true)
  expect(typeof bill.updatedAt).toBe('string')

  for (const s of bill.sponsors) {
    expect(typeof s.name).toBe('string')
    expect(s.party === null || typeof s.party === 'string').toBe(true)
    expect(s.role === null || typeof s.role === 'string').toBe(true)
    expect(typeof s.primary).toBe('boolean')
    expect(s.personId === null || typeof s.personId === 'string').toBe(true)
  }

  for (const v of bill.versions) {
    expect(typeof v.id).toBe('string')
    expect(typeof v.note).toBe('string')
    expect(typeof v.date).toBe('string')
    expect(Array.isArray(v.links)).toBe(true)
    for (const l of v.links) {
      expect(typeof l.url).toBe('string')
      expect(typeof l.mediaType).toBe('string')
    }
  }
}

function assertBillDetailShape(bill: NormalizedBill) {
  assertBillStubShape(bill)
  expect(Array.isArray(bill.actions)).toBe(true)
  expect(Array.isArray(bill.documents)).toBe(true)
  expect(Array.isArray(bill.votes)).toBe(true)
  expect(Array.isArray(bill.relatedBills)).toBe(true)

  for (const a of bill.actions) {
    expect(typeof a.description).toBe('string')
    expect(typeof a.date).toBe('string')
    expect(a.chamber === null || typeof a.chamber === 'string').toBe(true)
    expect(Array.isArray(a.classification)).toBe(true)
    expect(typeof a.order).toBe('number')
  }

  for (const v of bill.votes) {
    expect(typeof v.id).toBe('string')
    expect(typeof v.motionText).toBe('string')
    expect(typeof v.date).toBe('string')
    expect(typeof v.result).toBe('string')
    expect(v.chamber === null || typeof v.chamber === 'string').toBe(true)
    expect(Array.isArray(v.counts)).toBe(true)
    for (const c of v.counts) {
      expect(typeof c.option).toBe('string')
      expect(typeof c.value).toBe('number')
    }
  }
}

describe.skipIf(!hasKey)('OpenStates provider integration', () => {
  const provider = createOpenStatesProvider(apiKey)

  // Fetch all data once up front to stay within the 10/min rate limit
  let sessions: NormalizedSession[]
  let updatedBills: NormalizedBillStub[]
  let keywordBills: NormalizedBillStub[]
  let knownBill: NormalizedBill
  let billWithVotes: NormalizedBill

  beforeAll(async () => {
    sessions = await provider.fetchSessions('RI')

    const billsGen = provider.fetchUpdatedBills('RI', '2026', new Date('2026-05-14'))
    updatedBills = []
    for await (const bill of billsGen) {
      updatedBills.push(bill)
      if (updatedBills.length >= 5) break
    }

    const kwGen = provider.fetchKeywordMatches('RI', '2025', 'election', new Date('2025-01-01'))
    keywordBills = []
    for await (const bill of kwGen) {
      keywordBills.push(bill)
      if (keywordBills.length >= 5) break
    }

    knownBill = await provider.fetchBillDetail(KNOWN_BILL_ID)
    billWithVotes = await provider.fetchBillDetail(KNOWN_BILL_WITH_VOTES_ID)
  }, 30000)

  describe('fetchSessions', () => {
    it('returns sessions with correct shape', () => {
      expect(sessions.length).toBeGreaterThan(0)
      const session = sessions[0]
      expect(typeof session.identifier).toBe('string')
      expect(typeof session.name).toBe('string')
      expect(typeof session.classification).toBe('string')
      expect(typeof session.startDate).toBe('string')
      expect(typeof session.endDate).toBe('string')
    })

    it('includes the current 2026 session', () => {
      const current = sessions.find(s => s.identifier === '2026')
      expect(current).toBeDefined()
      expect(current!.classification).toBe('primary')
    })
  })

  describe('fetchUpdatedBills', () => {
    it('yields bill stubs with correct shape', () => {
      expect(updatedBills.length).toBeGreaterThan(0)
      for (const bill of updatedBills) {
        assertBillStubShape(bill)
      }
    })

    it('bills belong to the requested state and session', () => {
      for (const bill of updatedBills) {
        expect(bill.state).toBe('RI')
        expect(bill.session).toBe('2026')
      }
    })

    it('session value matches the identifier returned by fetchSessions', () => {
      const sessionId = sessions.find(s => s.identifier === '2026')?.identifier
      for (const bill of updatedBills) {
        expect(bill.session).toBe(sessionId)
      }
    })

    it('bills have updatedAt after the since date', () => {
      const since = new Date('2026-05-14')
      for (const bill of updatedBills) {
        expect(new Date(bill.updatedAt) >= since).toBe(true)
      }
    })
  })

  describe('fetchBillDetail', () => {
    it('returns full bill shape with actions and documents arrays', () => {
      assertBillDetailShape(knownBill)
    })

    it('bill id and state match request', () => {
      expect(knownBill.id).toBe(KNOWN_BILL_ID)
      expect(knownBill.state).toBe('RI')
    })

    it('actions are ordered numerically', () => {
      const orders = knownBill.actions.map(a => a.order)
      expect(orders).toEqual([...orders].sort((a, b) => a - b))
    })

    it('returns vote counts for a bill known to have votes', () => {
      assertBillDetailShape(billWithVotes)
      expect(billWithVotes.votes.length).toBeGreaterThan(0)
      const vote = billWithVotes.votes[0]
      expect(vote.counts.length).toBeGreaterThan(0)
      const yesCount = vote.counts.find(c => c.option === 'yes')
      expect(yesCount).toBeDefined()
      expect(yesCount!.value).toBeGreaterThan(0)
    })
  })

  describe('fetchKeywordMatches', () => {
    it('yields bill stubs with correct shape', () => {
      expect(keywordBills.length).toBeGreaterThan(0)
      for (const bill of keywordBills) {
        assertBillStubShape(bill)
      }
    })

    it('bills belong to the requested state', () => {
      for (const bill of keywordBills) {
        expect(bill.state).toBe('RI')
      }
    })
  })
})
