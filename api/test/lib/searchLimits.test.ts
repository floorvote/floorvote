import { describe, it, expect } from 'vitest'
import {
  byteLength, truncateToBytes, searchTermTooLong, searchWarnings,
  MAX_SEARCH_TERM_BYTES, MAX_SEARCH_TOKENS,
} from '../../../shared/searchLimits'

describe('byteLength', () => {
  it('counts ASCII as one byte each', () => {
    expect(byteLength('abc')).toBe(3)
  })
  it('counts multibyte characters by UTF-8 bytes', () => {
    expect(byteLength('é')).toBe(2)   // U+00E9
    expect(byteLength('😀')).toBe(4)  // astral plane
  })
})

describe('truncateToBytes', () => {
  it('returns the string unchanged when within budget', () => {
    expect(truncateToBytes('hello', MAX_SEARCH_TERM_BYTES)).toBe('hello')
  })
  it('truncates ASCII to the byte budget', () => {
    expect(truncateToBytes('a'.repeat(60), 48)).toBe('a'.repeat(48))
  })
  it('never splits a multibyte character', () => {
    const out = truncateToBytes('é'.repeat(25), 48) // 25×2 = 50 bytes
    expect(byteLength(out)).toBeLessThanOrEqual(48)
    expect(out).toBe('é'.repeat(24))                // 24×2 = 48 bytes
  })
})

describe('searchTermTooLong', () => {
  it('is false for a normal query', () => {
    expect(searchTermTooLong('voting rights act')).toBe(false)
  })
  it('is true for a single over-long token', () => {
    expect(searchTermTooLong('a'.repeat(49))).toBe(true)
  })
  it('is true for a long quoted phrase', () => {
    expect(searchTermTooLong('"an act relating to election administration and voter"')).toBe(true)
  })
  it('is false for a long multi-word query whose tokens are all short', () => {
    expect(searchTermTooLong('election administration and voter registration procedures act')).toBe(false)
  })
})

describe('searchWarnings', () => {
  const manyTerms = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(' ')

  it('is empty for a normal query', () => {
    expect(searchWarnings('voting rights act')).toEqual([])
  })
  it('warns when a term is too long (case A)', () => {
    expect(searchWarnings('a'.repeat(49))).toEqual(['Long search terms are shortened.'])
  })
  it('warns when there are too many terms (case B)', () => {
    expect(searchWarnings(manyTerms(MAX_SEARCH_TOKENS + 1)))
      .toEqual([`Only the first ${MAX_SEARCH_TOKENS} terms are searched.`])
  })
  it('warns for both, term length first then term count (A + B)', () => {
    const q = 'a'.repeat(49) + ' ' + manyTerms(MAX_SEARCH_TOKENS) // 1 long + MAX short = MAX+1 tokens
    expect(searchWarnings(q)).toEqual([
      'Long search terms are shortened.',
      `Only the first ${MAX_SEARCH_TOKENS} terms are searched.`,
    ])
  })
})
