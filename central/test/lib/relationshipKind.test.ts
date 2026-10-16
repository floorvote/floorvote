import { describe, it, expect } from 'vitest'
import { relationshipKind } from '../../src/lib/vocabulary'
import { getProvider } from '../../src/providers'

const legiscan = getProvider('legiscan')
const mga = getProvider('mga')

describe('relationshipKind', () => {
  it('reads a state\'s override before the provider\'s default', () => {
    expect(relationshipKind(legiscan, 'NJ', 'Same As')).toBe('identical')
    expect(relationshipKind(legiscan, 'MI', 'Same As')).toBe('package')
  })

  it('falls through to the default for a label the state doesn\'t override', () => {
    expect(relationshipKind(legiscan, 'MI', 'Crossfiled')).toBe('identical')
  })

  it('reads LegiScan\'s two spellings of a cross-file the same way', () => {
    expect(relationshipKind(legiscan, 'WA', 'Crossfiled')).toBe('identical')
    expect(relationshipKind(legiscan, 'WA', 'Cross-filed')).toBe('identical')
  })

  it('ignores case, spacing, and hyphens in a label', () => {
    expect(relationshipKind(legiscan, 'NJ', 'same  as')).toBe('identical')
    expect(relationshipKind(legiscan, 'NJ', ' SAME AS ')).toBe('identical')
  })

  it('serves an unmapped label as related, whatever the provider', () => {
    expect(relationshipKind(legiscan, 'TX', 'Similar To')).toBe('related')
    expect(relationshipKind(mga, 'MD', 'Same As')).toBe('related')
    expect(relationshipKind(getProvider('lis'), 'VA', 'Carry Over')).toBe('related')
  })

  it('reads a provider\'s own label, not another\'s', () => {
    expect(relationshipKind(mga, 'MD', 'Cross-filed')).toBe('identical')
  })
})
