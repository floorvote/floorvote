import { describe, it, expect } from 'vitest'
import { matchesWordBoundary, matchesUnion } from '../../src/lib/keywords'
import { KEYWORD_MATCH_CASES } from '../../../shared/keywordMatchFixtures'

describe('matchesWordBoundary', () => {
  it('matches "election" in "election law"', () => {
    expect(matchesWordBoundary('election law amendment', 'election')).toBe(true)
  })

  it('does NOT match "election" inside "selection"', () => {
    expect(matchesWordBoundary('Selection of primary care provider', 'election')).toBe(false)
  })

  it('matches "election" at start of string', () => {
    expect(matchesWordBoundary('election officials', 'election')).toBe(true)
  })
})

describe('matchesUnion', () => {
  it('matches a regular keyword via substring', () => {
    const result = matchesUnion('Voting rights expansion act', ['voting', 'ballot'])
    expect(result).toEqual({ matched: true, keyword: 'voting' })
  })

  it('returns no match when no keyword hits', () => {
    const result = matchesUnion('Vehicle registration fee increase', ['ballot'])
    expect(result).toEqual({ matched: false, keyword: '' })
  })

  it('uses word boundary for "election"', () => {
    expect(matchesUnion('Selection of primary care', ['election']).matched).toBe(false)
    expect(matchesUnion('Election law amendment', ['election']).matched).toBe(true)
  })
})

describe('matchesUnion — wildcard sentinel', () => {
  it('matches any text when the list contains "*"', () => {
    expect(matchesUnion('Tobacco Amendments', ['*'])).toEqual({ matched: true, keyword: '*' })
  })

  it('matches empty text when the list contains "*"', () => {
    expect(matchesUnion('', ['*'])).toEqual({ matched: true, keyword: '*' })
  })

  it('is unaffected by other keywords alongside "*"', () => {
    expect(matchesUnion('Water Usage Modifications', ['county', '*'])).toEqual({ matched: true, keyword: '*' })
  })

  it('still matches nothing for an empty list', () => {
    expect(matchesUnion('Election Law Amendments', [])).toEqual({ matched: false, keyword: '' })
  })

  it('treats "*extra" as an ordinary substring keyword, not the sentinel', () => {
    expect(matchesUnion('Tobacco Amendments', ['*extra'])).toEqual({ matched: false, keyword: '' })
  })

  it('does not let a literal asterisk in the text trigger the sentinel', () => {
    expect(matchesUnion('Budget * Amendments', ['county'])).toEqual({ matched: false, keyword: '' })
  })
})

// Both packages' test suites assert their OWN matcher against this one shared
// table (see shared/keywordMatchFixtures.ts), so a change to either matcher
// that is not mirrored on the other side fails that side's tests here.
describe('matchesKeywords — shared cross-matcher fixtures', () => {
  for (const { text, keywords, expected } of KEYWORD_MATCH_CASES) {
    it(`${JSON.stringify(keywords)} vs ${JSON.stringify(text)} → ${expected}`, () => {
      expect(matchesUnion(text, keywords).matched).toBe(expected)
    })
  }
})
