import { describe, it, expect } from 'vitest'
import { deriveStatus } from '../../src/providers/openstates'

describe('deriveStatus', () => {
  it('returns introduced for introduction-only actions', () => {
    expect(deriveStatus([
      { classification: ['introduction'], organization: { classification: 'lower' }, order: 1 },
    ])).toBe('introduced')
  })

  it('returns in_committee for committee-referral', () => {
    expect(deriveStatus([
      { classification: ['introduction'], organization: { classification: 'lower' }, order: 1 },
      { classification: ['committee-referral'], organization: { classification: 'lower' }, order: 2 },
    ])).toBe('in_committee')
  })

  it('returns passed_lower for passage in lower chamber', () => {
    expect(deriveStatus([
      { classification: ['introduction'], organization: { classification: 'lower' }, order: 1 },
      { classification: ['passage'], organization: { classification: 'lower' }, order: 2 },
    ])).toBe('passed_lower')
  })

  it('returns passed_upper for passage in upper chamber', () => {
    expect(deriveStatus([
      { classification: ['introduction'], organization: { classification: 'upper' }, order: 1 },
      { classification: ['passage'], organization: { classification: 'upper' }, order: 2 },
    ])).toBe('passed_upper')
  })

  it('returns passed when both chambers pass', () => {
    expect(deriveStatus([
      { classification: ['passage'], organization: { classification: 'lower' }, order: 1 },
      { classification: ['passage'], organization: { classification: 'upper' }, order: 2 },
    ])).toBe('passed')
  })

  it('returns enacted for executive-signature', () => {
    expect(deriveStatus([
      { classification: ['passage'], organization: { classification: 'lower' }, order: 1 },
      { classification: ['executive-signature'], organization: { classification: 'executive' }, order: 2 },
    ])).toBe('enacted')
  })

  it('returns enacted for became-law', () => {
    expect(deriveStatus([
      { classification: ['became-law'], organization: { classification: 'executive' }, order: 1 },
    ])).toBe('enacted')
  })

  it('returns vetoed for executive-veto', () => {
    expect(deriveStatus([
      { classification: ['passage'], organization: { classification: 'lower' }, order: 1 },
      { classification: ['executive-veto'], organization: { classification: 'executive' }, order: 2 },
    ])).toBe('vetoed')
  })

  it('returns failed for failure classification', () => {
    expect(deriveStatus([
      { classification: ['introduction'], organization: { classification: 'lower' }, order: 1 },
      { classification: ['failure'], organization: { classification: 'lower' }, order: 2 },
    ])).toBe('failed')
  })

  it('returns unknown for empty actions', () => {
    expect(deriveStatus([])).toBe('unknown')
  })
})
