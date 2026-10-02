import { describe, it, expect } from 'vitest'
import { dcStatusExplainer, dcTypeExplainer } from './dcLegislation'

describe('dcTypeExplainer', () => {
  it('explains the three act types LIMS names, case-insensitively', () => {
    expect(dcTypeExplainer('Emergency Bill')).toMatch(/90 days/)
    expect(dcTypeExplainer('Temporary Bill')).toMatch(/225 days/)
    expect(dcTypeExplainer(' permanent bill ')).toMatch(/60 days for certain criminal legislation/)
  })

  it('returns null for types it does not cover, including the LegiScan default', () => {
    expect(dcTypeExplainer('B')).toBeNull()
    expect(dcTypeExplainer(null)).toBeNull()
    expect(dcTypeExplainer(undefined)).toBeNull()
  })
})

describe('dcStatusExplainer', () => {
  it('explains review statuses with their clocks', () => {
    expect(dcStatusExplainer('Under Mayoral Review')).toMatch(/10 working days/)
    expect(dcStatusExplainer('Under Congressional Review')).toMatch(/in session/)
  })

  it('returns null for an unknown status', () => {
    expect(dcStatusExplainer('Introduced')).toBeNull()
  })
})
