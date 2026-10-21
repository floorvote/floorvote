import { describe, it, expect } from 'vitest'
import { parseHandle, toHandle, toLegacyHandle, toTenantHandle, HANDLE_FORM_HEADER, readsNeutralHandles } from '../../src/lib/billHandle'
import { HANDLE_FORM_HEADER as SHARED_HEADER } from '../../../shared/billHandle'

describe('bill handles', () => {
  it('builds the neutral bill: form', () => {
    expect(toHandle(123)).toBe('bill:123')
  })

  it('builds the legacy legiscan: form on request', () => {
    expect(toLegacyHandle(123)).toBe('legiscan:123')
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

// The neutral rename (#305): central accepts the neutral form everywhere it
// accepts the legacy one. Release 2 sends the neutral form to an instance that
// says it reads it, and the legacy form to every other.
describe('neutral bill handles', () => {
  const ids = [1, 9, 10, 501, 1900101, 2099974, 1012600769, 2 ** 31, Number.MAX_SAFE_INTEGER]

  it.each(ids)('parses the neutral form of %i to the same bill as its legacy twin and the bare id', (id) => {
    expect(parseHandle(`bill:${id}`)).toBe(id)
    expect(parseHandle(`bill:${id}`)).toBe(parseHandle(`legiscan:${id}`))
    expect(parseHandle(`bill:${id}`)).toBe(parseHandle(String(id)))
  })

  it('builds the neutral form', () => {
    for (const id of ids) expect(toHandle(id)).toBe(`bill:${id}`)
    expect(toHandle(501)).not.toContain('legiscan')
  })

  it('builds the form an instance reads: neutral if it says so, else legacy', () => {
    expect(toTenantHandle(501, true)).toBe('bill:501')
    expect(toTenantHandle(501, false)).toBe('legiscan:501')
  })

  it('shares the header name with the instances', () => {
    expect(HANDLE_FORM_HEADER).toBe('x-handle-form')
    expect(HANDLE_FORM_HEADER).toBe(SHARED_HEADER)
  })

  it.each([
    ['the neutral value', 'neutral', true],
    ['another value', 'legacy', false],
    ['no header', undefined, false],
    ['an empty header', '', false],
    ['a different case', 'Neutral', false],
  ])('reads %s of the header', (_, value, expected) => {
    expect(readsNeutralHandles(value)).toBe(expected)
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

describe('leading zeros', () => {
  it.each(['legiscan:012', 'bill:012', '012', 'bill:007'])('rejects %s', (value) => {
    expect(parseHandle(value)).toBeNull()
  })
})
