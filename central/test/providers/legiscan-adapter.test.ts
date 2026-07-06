import { describe, it, expect } from 'vitest'

describe('createLegiscanProvider', () => {
  it('exports a factory that returns a BillProvider', async () => {
    const { createLegiscanProvider } = await import('../../src/providers/legiscan')
    const provider = createLegiscanProvider('fake-key')
    expect(provider).toHaveProperty('fetchSessions')
    expect(provider).toHaveProperty('fetchUpdatedBills')
    expect(provider).toHaveProperty('fetchBillDetail')
    expect(provider).toHaveProperty('fetchKeywordMatches')
  })
})
