import { describe, it, expect } from 'vitest'
import { matchesWordBoundary, matchesUnion } from '../../src/lib/keywords'

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
