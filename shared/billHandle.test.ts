import { describe, it, expect } from 'vitest'
import { HANDLE_PREFIX, isHandle, parseHandle, toHandle } from './billHandle'

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
})
