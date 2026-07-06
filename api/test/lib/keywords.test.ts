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
