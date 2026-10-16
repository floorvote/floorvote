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

// Release 1 of the neutral rename (#305): central accepts the neutral form
// everywhere it accepts the legacy one, and keeps sending the legacy form.
describe('neutral bill handles', () => {
  const ids = [1, 9, 10, 501, 1900101, 2099974, 1012600769, 2 ** 31, Number.MAX_SAFE_INTEGER]

  it.each(ids)('parses the neutral form of %i to the same bill as its legacy twin and the bare id', (id) => {
    expect(parseHandle(`bill:${id}`)).toBe(id)
    expect(parseHandle(`bill:${id}`)).toBe(parseHandle(`legiscan:${id}`))
    expect(parseHandle(`bill:${id}`)).toBe(parseHandle(String(id)))
  })

  it('still builds only the legacy form', () => {
    for (const id of ids) expect(toHandle(id)).toBe(`legiscan:${id}`)
    expect(toHandle(501)).not.toContain('bill:')
  })

  it.each([
    ['a missing neutral id', 'bill:'],
    ['neutral id zero', 'bill:0'],
    ['legacy id zero', 'legiscan:0'],
    ['a bare zero', '0'],
    ['trailing junk after a neutral id', 'bill:12abc'],
    ['trailing junk after a legacy id', 'legiscan:12abc'],
    ['trailing junk after a bare id', '12abc'],
    ['a negative id', 'bill:-5'],
    ['a decimal', 'bill:1.5'],
    ['whitespace around the id', ' bill:12 '],
    ['a wrong prefix', 'item:12'],
    ['an uppercase prefix', 'BILL:12'],
    ['a provider name inside the neutral prefix', 'legiscan-bill:12'],
    ['a provider name after the neutral prefix', 'bill-legiscan:12'],
    ['both prefixes', 'bill:legiscan:12'],
    ['a doubled prefix', 'bill:bill:12'],
  ])('rejects %s', (_, value) => {
    expect(parseHandle(value)).toBeNull()
  })
})
