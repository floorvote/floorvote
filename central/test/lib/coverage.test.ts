import { describe, it, expect } from 'vitest'
import { mergeCoverage } from '../../src/lib/coverage'

describe('mergeCoverage', () => {
  it('unions existing with incoming, preserving existing order then new', () => {
    expect(mergeCoverage(['NJ', 'RI'], ['CA'])).toEqual(['NJ', 'RI', 'CA'])
  })

  it('dedups already-present states', () => {
    expect(mergeCoverage(['NJ', 'RI'], ['RI', 'NJ'])).toEqual(['NJ', 'RI'])
  })

  it('treats null/undefined existing as a new tenant (just incoming)', () => {
    expect(mergeCoverage(null, ['NJ', 'RI'])).toEqual(['NJ', 'RI'])
    expect(mergeCoverage(undefined, ['NJ'])).toEqual(['NJ'])
  })

  it('collapses to wildcard if either side is wildcard', () => {
    expect(mergeCoverage(['*'], ['NJ'])).toEqual(['*'])
    expect(mergeCoverage(['NJ'], ['*'])).toEqual(['*'])
  })

  it('adds a single new state to an existing list', () => {
    expect(mergeCoverage(['NJ', 'RI', 'WY', 'WI'], ['US'])).toEqual(['NJ', 'RI', 'WY', 'WI', 'US'])
  })
})
