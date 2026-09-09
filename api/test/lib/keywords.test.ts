import { describe, it, expect } from 'vitest'
import { matchesKeywords } from '../../src/lib/keywords'
import { KEYWORD_MATCH_CASES } from '../../../shared/keywordMatchFixtures'

describe('matchesKeywords — glob semantics', () => {
  it('matches a bare keyword as a whole word', () => {
    expect(matchesKeywords('Election Administration Act', ['election'])).toBe(true)
  })

  it('does NOT match a bare keyword inside a longer word', () => {
    expect(matchesKeywords('Rules governing the selection of jury members', ['election'])).toBe(false)
    expect(matchesKeywords('Prohibits reelection after term limit', ['election'])).toBe(false)
    expect(matchesKeywords('Establishes preelection disclosure', ['election'])).toBe(false)
  })

  it('does NOT match a bare keyword against a plural', () => {
    expect(matchesKeywords('general elections calendar', ['election'])).toBe(false)
  })

  it('matches a plural with a trailing star', () => {
    expect(matchesKeywords('general elections calendar', ['election*'])).toBe(true)
    expect(matchesKeywords('Rules governing the selection', ['election*'])).toBe(false)
  })

  it('matches mid-word with surrounding stars', () => {
    expect(matchesKeywords('mail-in ballot application form', ['*ballot*'])).toBe(true)
  })
})

describe('matchesKeywords — wildcard sole membership', () => {
  it('matches any text when "*" is the only keyword', () => {
    expect(matchesKeywords('Tobacco Amendments', ['*'])).toBe(true)
  })

  it('matches empty text when "*" is the only keyword', () => {
    expect(matchesKeywords('', ['*'])).toBe(true)
  })

  it('drops "*" when other keywords are present', () => {
    expect(matchesKeywords('Water Usage Modifications', ['county', '*'])).toBe(false)
    expect(matchesKeywords('County Water Usage', ['county', '*'])).toBe(true)
  })

  it('still matches nothing for an empty list', () => {
    expect(matchesKeywords('Election Law Amendments', [])).toBe(false)
  })

  it('treats "*extra" as ends-with, not the sentinel', () => {
    expect(matchesKeywords('Tobacco Amendments', ['*extra'])).toBe(false)
    expect(matchesKeywords('An extra provision', ['*extra'])).toBe(true)
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
