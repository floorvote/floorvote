import { describe, it, expect } from 'vitest'
import { parseHex, colorDistance, clusterColors, clusterNumbers, extractStyleValues } from './style-audit'

describe('parseHex', () => {
  it('parses 6-digit hex', () => {
    expect(parseHex('#94a3b8')).toEqual({ r: 148, g: 163, b: 184 })
  })
  it('parses 3-digit shorthand', () => {
    expect(parseHex('#999')).toEqual({ r: 153, g: 153, b: 153 })
  })
  it('returns null for non-hex', () => {
    expect(parseHex('rgba(0,0,0,.5)')).toBeNull()
  })
})

describe('colorDistance', () => {
  it('is 0 for identical colors', () => {
    expect(colorDistance('#94a3b8', '#94a3b8')).toBe(0)
  })
  it('rates slate-400 vs gray-400 as near (small distance)', () => {
    expect(colorDistance('#94a3b8', '#9ca3af')).toBeLessThan(20)
  })
  it('rates muted gray vs red as far', () => {
    expect(colorDistance('#94a3b8', '#dc2626')).toBeGreaterThan(100)
  })
})

describe('clusterColors', () => {
  it('groups near-identical colors and counts occurrences', () => {
    const input = [
      { value: '#94a3b8', count: 100 },
      { value: '#9ca3af', count: 6 },
      { value: '#999999', count: 3 },
      { value: '#dc2626', count: 9 },
    ]
    // threshold=55: #94a3b8↔#9ca3af≈19, #94a3b8↔#999999≈53, #94a3b8↔#dc2626≈354
    const clusters = clusterColors(input, 55)
    expect(clusters).toHaveLength(2)
    const grayCluster = clusters.find((c) => c.members.length === 3)!
    expect(grayCluster.canonical).toBe('#94a3b8')
    expect(grayCluster.totalCount).toBe(109)
  })
})

describe('clusterNumbers', () => {
  it('groups numbers within delta, most common value is canonical', () => {
    const clusters = clusterNumbers(
      [ { value: 4, count: 29 }, { value: 5, count: 2 }, { value: 6, count: 56 }, { value: 20, count: 1 } ],
      1,
    )
    const c = clusters.find((x) => x.members.includes(5))!
    expect(c.canonical).toBe(6)
  })
})

describe('extractStyleValues', () => {
  it('pulls hex colors and numeric style props from source', () => {
    const src = `const a = { color: '#94a3b8', borderRadius: 6, fontSize: 12 }`
    const found = extractStyleValues(src)
    expect(found.colors).toContain('#94a3b8')
    expect(found.radii).toContain(6)
    expect(found.fontSizes).toContain(12)
  })
})
