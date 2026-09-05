import { describe, it, expect } from 'vitest'
import { matchesKeywords } from '../../src/lib/keywords'
import { KEYWORD_MATCH_CASES } from '../../../shared/keywordMatchFixtures'

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

// Both packages' test suites assert their OWN matcher against this one shared
// table (see shared/keywordMatchFixtures.ts), so a change to either matcher
// that is not mirrored on the other side fails that side's tests here.
describe('matchesKeywords — shared cross-matcher fixtures', () => {
  for (const { text, keywords, expected } of KEYWORD_MATCH_CASES) {
    it(`${JSON.stringify(keywords)} vs ${JSON.stringify(text)} → ${expected}`, () => {
      expect(matchesKeywords(text, keywords)).toBe(expected)
    })
  }
})
