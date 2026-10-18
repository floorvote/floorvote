import { describe, it, expect } from 'vitest'
import { httpUrl } from './httpUrl'

describe('httpUrl', () => {
  it.each(['https://legislature.example/members/diaz', 'http://legislature.example/diaz', '  https://legislature.example/x  '])('keeps %j', (u) => {
    expect(httpUrl(u)).toBe(u.trim())
  })
  it.each(['javascript:alert(1)', 'data:text/html,hi', 'vbscript:msgbox(1)', '/relative', '//legislature.example/x', 'legislature.example/x', 'not a url', '', '   '])('rejects %j', (u) => {
    expect(httpUrl(u)).toBeNull()
  })
  it('is null for null and undefined', () => {
    expect(httpUrl(null)).toBeNull()
    expect(httpUrl(undefined)).toBeNull()
  })
  // Stored JSON and a provider's feed are not typed, so a value can be anything.
  it.each([[123], [{ href: 'https://x.example' }], [['https://x.example']], [true], [0]])('is null, and does not throw, for the non-string %j', (v) => {
    expect(httpUrl(v as never)).toBeNull()
  })
})
