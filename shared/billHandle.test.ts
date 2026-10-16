import { describe, it, expect } from 'vitest'
import { HANDLE_PREFIX, NEUTRAL_HANDLE_PREFIX, isHandle, normalizeHandle, parseHandle, toHandle, toLegacyHandle } from './billHandle'

describe('bill handles', () => {
  it('builds the legacy legiscan: form', () => {
    expect(toHandle(501)).toBe('legiscan:501')
  })

  it('parses a handle back to the central bill id', () => {
    expect(parseHandle('legiscan:501')).toBe(501)
    expect(parseHandle(toHandle(2099974))).toBe(2099974)
  })

  it.each([
    ['a draft (null external id)', null],
    ['undefined', undefined],
    ['empty', ''],
    ['a legacy ocd-bill id', 'ocd-bill/abc'],
    ['id zero', 'legiscan:0'],
    ['a missing id', 'legiscan:'],
    ['trailing junk', 'legiscan:12abc'],
    ['a bare number', '501'],
  ])('returns null for %s', (_, value) => {
    expect(parseHandle(value)).toBeNull()
    expect(isHandle(value)).toBe(false)
  })

  it('isHandle accepts a handle', () => {
    expect(isHandle('legiscan:501')).toBe(true)
  })

  it('every handle starts with HANDLE_PREFIX, for SQL LIKE filters', () => {
    expect(toHandle(7).startsWith(HANDLE_PREFIX)).toBe(true)
  })

  it('every handle, neutral or legacy, starts with one of the known prefixes', () => {
    expect([HANDLE_PREFIX, NEUTRAL_HANDLE_PREFIX]).toEqual(['legiscan:', 'bill:'])
  })
})

// Release 1 of the neutral rename (#305): both forms parse, and only the legacy
// form is built. A neutral handle names the same central bill as its legacy twin.
describe('neutral bill handles', () => {
  // Central row ids come from any provider, so any positive integer is a shape:
  // small, large, and past 2^31.
  const ids = [1, 9, 10, 501, 1900101, 2099974, 1012600769, 2 ** 31, Number.MAX_SAFE_INTEGER]

  it.each(ids)('parses the neutral form of %i to the same bill as its legacy twin', (id) => {
    expect(parseHandle(`bill:${id}`)).toBe(id)
    expect(parseHandle(`bill:${id}`)).toBe(parseHandle(`legiscan:${id}`))
    expect(isHandle(`bill:${id}`)).toBe(true)
  })

  it('still builds the legacy form, so central and tenants agree during the rollout', () => {
    expect(toHandle(501)).toBe('legiscan:501')
    expect(toLegacyHandle(501)).toBe('legiscan:501')
  })

  it('normalizeHandle rewrites a neutral handle to the stored (legacy) form', () => {
    expect(normalizeHandle('bill:501')).toBe('legiscan:501')
    expect(normalizeHandle('legiscan:501')).toBe('legiscan:501')
  })

  it.each([
    ['a draft (null)', null],
    ['undefined', undefined],
    ['empty', ''],
    ['a legacy ocd-bill id', 'ocd-bill/abc'],
    ['a bare number', '501'],
    ['a malformed handle', 'bill:12abc'],
  ])('normalizeHandle leaves %s as it is', (_, value) => {
    expect(normalizeHandle(value as string | null | undefined)).toBe(value)
  })

  it.each([
    ['empty', ''],
    ['a missing id', 'bill:'],
    ['id zero', 'bill:0'],
    ['a leading zero', 'bill:012'],
    ['a negative id', 'bill:-5'],
    ['a decimal', 'bill:1.5'],
    ['trailing junk', 'bill:12abc'],
    ['trailing whitespace', 'bill:12 '],
    ['a trailing newline', 'bill:12\n'],
    ['leading whitespace', ' bill:12'],
    ['an uppercase prefix', 'BILL:12'],
    ['a wrong prefix', 'item:12'],
    ['a provider name inside the neutral prefix', 'legiscan-bill:12'],
    ['a provider name after the neutral prefix', 'bill-legiscan:12'],
    ['both prefixes', 'bill:legiscan:12'],
    ['a doubled prefix', 'bill:bill:12'],
    ['a slash instead of a colon', 'bill/12'],
    ['a prefix with no colon', 'bill12'],
  ])('rejects %s', (_, value) => {
    expect(parseHandle(value)).toBeNull()
    expect(isHandle(value)).toBe(false)
    expect(normalizeHandle(value)).toBe(value)
  })

  it('the neutral prefix never names a provider', () => {
    for (const provider of ['legiscan', 'openstates', 'lims', 'mga', 'lis']) {
      expect(NEUTRAL_HANDLE_PREFIX.toLowerCase()).not.toContain(provider)
    }
  })

  it('a handle round-trips through normalize without changing the bill', () => {
    for (const id of ids) expect(parseHandle(normalizeHandle(`bill:${id}`))).toBe(id)
  })
})
