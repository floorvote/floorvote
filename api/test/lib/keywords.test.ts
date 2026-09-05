import { describe, it, expect } from 'vitest'
import { matchesKeywords } from '../../src/lib/keywords'

describe('matchesKeywords — word boundary enforcement for "election"', () => {
  // "election" is in WORD_BOUNDARY_KEYWORDS: must not match mid-word occurrences.
  // This mirrors the same set in central/src/lib/keywords.ts — both must stay in sync.
  it('matches "election" as a standalone word', () => {
    expect(matchesKeywords('Election Administration Act', ['election'])).toBe(true)
  })

  it('matches "election" at the start of a compound phrase', () => {
    expect(matchesKeywords('election security improvements', ['election'])).toBe(true)
  })

  it('does NOT match "election" inside "reelection"', () => {
    expect(matchesKeywords('Prohibits reelection of incumbent after term limit', ['election'])).toBe(false)
  })

  it('does NOT match "election" inside "selection"', () => {
    expect(matchesKeywords('Rules governing the selection of jury members', ['election'])).toBe(false)
  })

  it('does NOT match "election" inside "preelection"', () => {
    expect(matchesKeywords('Establishes preelection disclosure requirements', ['election'])).toBe(false)
  })

  it('still matches other keywords (no word boundary) like "ballot" mid-string', () => {
    expect(matchesKeywords('mail-in ballot application form', ['ballot'])).toBe(true)
  })
})

describe('matchesKeywords — wildcard sentinel', () => {
  it('matches any text when the list contains "*"', () => {
    expect(matchesKeywords('Tobacco Amendments', ['*'])).toBe(true)
  })

  it('matches empty text when the list contains "*"', () => {
    expect(matchesKeywords('', ['*'])).toBe(true)
  })

  it('is unaffected by other keywords alongside "*"', () => {
    expect(matchesKeywords('Water Usage Modifications', ['county', '*'])).toBe(true)
  })

  it('still matches nothing for an empty list', () => {
    expect(matchesKeywords('Election Law Amendments', [])).toBe(false)
  })

  it('treats "*extra" as an ordinary substring keyword, not the sentinel', () => {
    expect(matchesKeywords('Tobacco Amendments', ['*extra'])).toBe(false)
  })
})

// The two packages must agree bill-for-bill: central decides what to link and
// fetch, the tenant decides what to analyze. A divergence would silently
// analyze a different set than central delivered.
describe('matchesKeywords — parity with central matchesUnion', () => {
  const CASES: Array<{ text: string; keywords: string[]; expected: boolean }> = [
    { text: 'Tobacco Amendments', keywords: ['*'], expected: true },
    { text: '', keywords: ['*'], expected: true },
    { text: 'Tobacco Amendments', keywords: [], expected: false },
    { text: 'Tobacco Amendments', keywords: ['*extra'], expected: false },
    { text: 'County Budget Amendments', keywords: ['county'], expected: true },
    { text: 'Selection of a provider', keywords: ['election'], expected: false },
    { text: 'Election Law Amendments', keywords: ['election'], expected: true },
  ]

  for (const { text, keywords, expected } of CASES) {
    it(`${JSON.stringify(keywords)} vs ${JSON.stringify(text)} → ${expected}`, () => {
      expect(matchesKeywords(text, keywords)).toBe(expected)
    })
  }
})
