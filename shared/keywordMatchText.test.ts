import { describe, it, expect } from 'vitest'
import { billMatchText, matchesKeywords } from './keywords'
import { BILL_KEYWORD_MATCH_CASES } from './keywordMatchFixtures'

describe('billMatchText', () => {
  it('joins title, description, and bill number with single spaces', () => {
    expect(billMatchText({ title: 'Ballot Access', description: 'Polling places.', billNumber: 'HB 1' }))
      .toBe('Ballot Access Polling places. HB 1')
  })

  it('treats a missing title or description as empty text', () => {
    expect(billMatchText({ title: 'Ballot Access', description: null, billNumber: 'HB 1' })).toBe('Ballot Access  HB 1')
    expect(billMatchText({ title: null, description: undefined, billNumber: 'HB 1' })).toBe('  HB 1')
  })

  it('includes the bill number even when the other fields are empty', () => {
    expect(matchesKeywords(billMatchText({ title: '', description: '', billNumber: 'SB 7' }), ['sb 7'])).toBe(true)
  })

  it.each(BILL_KEYWORD_MATCH_CASES)('$name', ({ bill, keywords, expected }) => {
    expect(matchesKeywords(billMatchText(bill), keywords)).toBe(expected)
  })
})
