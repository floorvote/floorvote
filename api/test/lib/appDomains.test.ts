import { describe, it, expect } from 'vitest'
import { parseAppDomains } from '../../src/lib/appDomains'

describe('parseAppDomains', () => {
  it('returns [] for undefined', () => {
    expect(parseAppDomains(undefined)).toEqual([])
  })
  it('returns [] for an empty or whitespace string', () => {
    expect(parseAppDomains('')).toEqual([])
    expect(parseAppDomains('   ')).toEqual([])
  })
  it('parses a single domain', () => {
    expect(parseAppDomains('example.com')).toEqual(['example.com'])
  })
  it('splits and trims a comma list, dropping empties', () => {
    expect(parseAppDomains('example.com, example.org ,')).toEqual(['example.com', 'example.org'])
  })
})
