import { describe, it, expect } from 'vitest'
import { parseEmailList } from '../../../shared/operator'

describe('parseEmailList', () => {
  it('returns [] for undefined or empty', () => {
    expect(parseEmailList(undefined)).toEqual([])
    expect(parseEmailList('')).toEqual([])
    expect(parseEmailList('  ')).toEqual([])
  })
  it('splits, trims, and drops empties', () => {
    expect(parseEmailList('a@x.org')).toEqual(['a@x.org'])
    expect(parseEmailList(' a@x.org , b@y.org ')).toEqual(['a@x.org', 'b@y.org'])
    expect(parseEmailList('a@x.org,,b@y.org,')).toEqual(['a@x.org', 'b@y.org'])
  })
})
