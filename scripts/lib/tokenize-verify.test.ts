import { describe, it, expect } from 'vitest'
import {
  normHex,
  canonicalColor,
  canonicalRadius,
  canonicalFontSize,
  extractOld,
  extractNew,
  verify,
} from './tokenize-verify'
import type { TokenMaps } from './tokenize-verify'

// ---------------------------------------------------------------------------
// normHex
// ---------------------------------------------------------------------------
describe('normHex', () => {
  it('expands 3-digit shorthand to 6-digit lowercase', () => {
    expect(normHex('#FFF')).toBe('#ffffff')
    expect(normHex('#abc')).toBe('#aabbcc')
    expect(normHex('#0aF')).toBe('#00aaff')
  })

  it('lowercases an already-6-digit hex', () => {
    expect(normHex('#abcdef')).toBe('#abcdef')
    expect(normHex('#ABCDEF')).toBe('#abcdef')
    expect(normHex('#1a2B3c')).toBe('#1a2b3c')
  })
})

// ---------------------------------------------------------------------------
// canonicalColor
// ---------------------------------------------------------------------------
describe('canonicalColor', () => {
  it('maps a known absorb to its canonical', () => {
    expect(canonicalColor('#9ca3af')).toBe('#94a3b8')
    expect(canonicalColor('#e8edf2')).toBe('#e2e8f0')
    expect(canonicalColor('#fef9c3')).toBe('#fef3c7')
    expect(canonicalColor('#fef2f2')).toBe('#fff5f5')
  })

  it('is identity for unknown colors', () => {
    expect(canonicalColor('#123456')).toBe('#123456')
    expect(canonicalColor('#0f172a')).toBe('#0f172a')
  })

  it('normalizes input before lookup (#FFFFFF -> #ffffff canonical)', () => {
    // #ffffff is in the map (maps to itself / canonical white)
    expect(canonicalColor('#FFFFFF')).toBe('#ffffff')
    // #9CA3AF uppercase should still map
    expect(canonicalColor('#9CA3AF')).toBe('#94a3b8')
  })
})

// ---------------------------------------------------------------------------
// canonicalRadius
// ---------------------------------------------------------------------------
describe('canonicalRadius', () => {
  it('collapses to canonical tier', () => {
    expect(canonicalRadius(1)).toBe(2)
    expect(canonicalRadius(2)).toBe(2)
    expect(canonicalRadius(3)).toBe(4)
    expect(canonicalRadius(4)).toBe(4)
    expect(canonicalRadius(5)).toBe(4)
    expect(canonicalRadius(6)).toBe(6)
    expect(canonicalRadius(7)).toBe(6)
    expect(canonicalRadius(8)).toBe(8)
    expect(canonicalRadius(10)).toBe(8)
    expect(canonicalRadius(12)).toBe(12)
    expect(canonicalRadius(20)).toBe(12)
    expect(canonicalRadius(99)).toBe(999)
    expect(canonicalRadius(999)).toBe(999)
  })

  it('is identity for values not in the table', () => {
    expect(canonicalRadius(50)).toBe(50)
    expect(canonicalRadius(15)).toBe(15)
  })
})

// ---------------------------------------------------------------------------
// canonicalFontSize
// ---------------------------------------------------------------------------
describe('canonicalFontSize', () => {
  it('collapses to canonical tier', () => {
    expect(canonicalFontSize(9)).toBe(10)
    expect(canonicalFontSize(10)).toBe(10)
    expect(canonicalFontSize(11)).toBe(12)
    expect(canonicalFontSize(12)).toBe(12)
    expect(canonicalFontSize(13)).toBe(12)
    expect(canonicalFontSize(14)).toBe(14)
    expect(canonicalFontSize(15)).toBe(14)
  })

  it('is identity for values not in the table', () => {
    expect(canonicalFontSize(16)).toBe(16)
    expect(canonicalFontSize(18)).toBe(18)
    expect(canonicalFontSize(20)).toBe(20)
    expect(canonicalFontSize(22)).toBe(22)
  })
})

// ---------------------------------------------------------------------------
// extractOld
// ---------------------------------------------------------------------------
describe('extractOld', () => {
  it('extracts hex colors, border radii, font sizes, font weights', () => {
    const src = `
      const style = {
        color: '#9ca3af',
        backgroundColor: '#E8EDF2',
        borderRadius: 4,
        fontSize: 13,
        fontWeight: 600,
      }
    `
    const result = extractOld(src)
    expect(result.colors).toContain('#9ca3af')
    expect(result.colors).toContain('#e8edf2') // normalized
    expect(result.radii).toContain(4)
    expect(result.fontSizes).toContain(13)
    expect(result.fontWeights).toContain(600)
  })

  it('skips 4-digit and 8-digit alpha hex values', () => {
    const src = `color: '#rgba0000ff', background: '#12345678', other: '#abc'`
    const result = extractOld(src)
    // 8-digit should be skipped, 3-digit kept
    expect(result.colors).not.toContain('#12345678')
    expect(result.colors).toContain('#aabbcc') // #abc normalized
  })

  it('handles multiple occurrences (multiset)', () => {
    const src = `borderRadius: 4; borderRadius: 4; fontSize: 12`
    const result = extractOld(src)
    expect(result.radii).toEqual([4, 4])
    expect(result.fontSizes).toEqual([12])
  })

  it('captures CSS named color keywords as their hex equivalents', () => {
    const src = `background: 'white', color: '#0f172a'`
    const result = extractOld(src)
    expect(result.colors).toContain('#ffffff')
    expect(result.colors).toContain('#0f172a')
  })
})

// ---------------------------------------------------------------------------
// extractNew
// ---------------------------------------------------------------------------
describe('extractNew', () => {
  const maps: TokenMaps = {
    color: { textMuted: '#94a3b8', white: '#fff' },
    radius: { sm: 4, pill: 999 },
    fontSize: { sm: 12 },
    fontWeight: { semibold: 600 },
  }

  it('resolves token references to their values', () => {
    const src = `
      color: color.textMuted,
      borderRadius: radius.sm,
      fontSize: fontSize.sm,
      fontWeight: fontWeight.semibold,
    `
    const result = extractNew(src, maps)
    expect(result.colors).toContain('#94a3b8')
    expect(result.radii).toContain(4)
    expect(result.fontSizes).toContain(12)
    expect(result.fontWeights).toContain(600)
  })

  it('also captures remaining raw literals', () => {
    const src = `color: '#0f172a', borderRadius: 8, fontSize: 16`
    const result = extractNew(src, maps)
    expect(result.colors).toContain('#0f172a')
    expect(result.radii).toContain(8)
    expect(result.fontSizes).toContain(16)
  })

  it('normalizes color token values (handles #fff shorthand)', () => {
    const src = `color: color.white`
    const result = extractNew(src, maps)
    expect(result.colors).toContain('#ffffff')
  })

  it('throws on unknown token name', () => {
    const src = `color: color.nope`
    expect(() => extractNew(src, maps)).toThrow(/nope/)
  })

  it('throws on unknown radius token', () => {
    const src = `borderRadius: radius.unknown`
    expect(() => extractNew(src, maps)).toThrow(/unknown/)
  })
})

// ---------------------------------------------------------------------------
// verify — PASS case
// ---------------------------------------------------------------------------
describe('verify', () => {
  it('returns ok:true when old values canonicalize to same as new token values', () => {
    const oldSrc = `{ color: '#9ca3af', borderRadius: 3, fontSize: 13 }`
    const newSrc = `{ color: color.textMuted, borderRadius: radius.sm, fontSize: fontSize.sm }`
    const maps: TokenMaps = {
      color: { textMuted: '#94a3b8' },
      radius: { sm: 4 },
      fontSize: { sm: 12 },
      fontWeight: {},
    }
    const result = verify(oldSrc, newSrc, maps)
    expect(result.ok).toBe(true)
    expect(result.problems).toHaveLength(0)
  })

  // FAIL — wrong radius token (pill instead of sm)
  it('returns ok:false when new uses a different token value than canonical old', () => {
    const oldSrc = `{ color: '#9ca3af', borderRadius: 3, fontSize: 13 }`
    const newSrc = `{ color: color.textMuted, borderRadius: radius.pill, fontSize: fontSize.sm }`
    const maps: TokenMaps = {
      color: { textMuted: '#94a3b8' },
      radius: { pill: 999, sm: 4 },
      fontSize: { sm: 12 },
      fontWeight: {},
    }
    const result = verify(oldSrc, newSrc, maps)
    expect(result.ok).toBe(false)
    expect(result.problems.some(p => /radius/i.test(p))).toBe(true)
  })

  // FAIL — unknown token throws
  it('throws when new source references an unknown token', () => {
    const oldSrc = `{ color: '#9ca3af' }`
    const newSrc = `{ color: color.nope }`
    const maps: TokenMaps = {
      color: {},
      radius: {},
      fontSize: {},
      fontWeight: {},
    }
    expect(() => verify(oldSrc, newSrc, maps)).toThrow(/nope/)
  })

  // fontWeight identity
  it('treats fontWeight as identity (no collapse)', () => {
    const oldSrc = `fontWeight: 600`
    const newSrc = `fontWeight: fontWeight.semibold`
    const maps: TokenMaps = {
      color: {},
      radius: {},
      fontSize: {},
      fontWeight: { semibold: 600 },
    }
    const result = verify(oldSrc, newSrc, maps)
    expect(result.ok).toBe(true)
  })

  // multiset — two different radii must both match
  it('handles multiset: two radius values both present', () => {
    const oldSrc = `borderRadius: 3; borderRadius: 8`
    const newSrc = `borderRadius: radius.sm; borderRadius: radius.lg`
    const maps: TokenMaps = {
      color: {},
      radius: { sm: 4, lg: 8 },
      fontSize: {},
      fontWeight: {},
    }
    const result = verify(oldSrc, newSrc, maps)
    // old: 3->4(canon), 8->8(canon). new: sm=4, lg=8. matches.
    expect(result.ok).toBe(true)
  })
})
