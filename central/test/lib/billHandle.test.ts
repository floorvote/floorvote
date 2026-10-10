import { describe, it, expect } from 'vitest'
import { parseHandle, toHandle } from '../../src/lib/billHandle'

describe('bill handles', () => {
  it('builds the legacy legiscan: form', () => {
    expect(toHandle(123)).toBe('legiscan:123')
  })

  it('parses a handle or a bare id, as central routes accept both', () => {
    expect(parseHandle('legiscan:123')).toBe(123)
    expect(parseHandle('123')).toBe(123)
    expect(parseHandle(toHandle(2099974))).toBe(2099974)
  })

  it.each([
    ['empty', ''],
    ['a legacy ocd-bill id', 'ocd-bill/abc'],
    ['a missing id', 'legiscan:'],
    ['words', 'not-a-bill'],
  ])('returns null for %s', (_, value) => {
    expect(parseHandle(value)).toBeNull()
  })
})
