import { describe, it, expect } from 'vitest'
import { analyzeSeries, MIN_DAYS } from './anomalyWatch'
import type { DailyRowsRead } from './d1Analytics'

function series(...vals: number[]): DailyRowsRead[] {
  return vals.map((rowsRead, i) => ({ date: `2026-06-${String(i + 1).padStart(2, '0')}`, rowsRead }))
}

describe('analyzeSeries', () => {
  it('flags a spike above max(factor×baseline, floor)', () => {
    const a = analyzeSeries('db', 'id', series(10, 10, 10, 10, 10, 10, 10, 100), 5, 0)
    expect(a.latest).toBe(100)
    expect(a.baseline).toBe(10)
    expect(a.threshold).toBe(50) // max(5×10, 0)
    expect(a.flagged).toBe(true)
    expect(a.multiple).toBe(10)
    expect(a.insufficientData).toBe(false)
  })

  it('does not flag normal traffic under the floor', () => {
    const a = analyzeSeries('db', 'id', series(10, 10, 10, 10, 10, 10, 10, 100), 5, 50_000_000)
    expect(a.threshold).toBe(50_000_000) // floor dominates
    expect(a.flagged).toBe(false)
  })

  it('reports insufficient data below MIN_DAYS without flagging', () => {
    const a = analyzeSeries('db', 'id', series(10, 10, 10), 5, 0)
    expect(a.days).toBeLessThan(MIN_DAYS)
    expect(a.insufficientData).toBe(true)
    expect(a.flagged).toBe(false)
  })

  it('reports an infinite multiple when the baseline is zero', () => {
    const a = analyzeSeries('db', 'id', series(0, 0, 0, 0, 0, 0, 0, 100), 5, 0)
    expect(a.baseline).toBe(0)
    expect(a.multiple).toBe(Infinity)
    expect(a.flagged).toBe(true) // 100 > max(0, 0)
  })

  it('a low factor override trips on otherwise-normal traffic (smoke-test path)', () => {
    // Proves the alert logic fires when thresholds are lowered for verification.
    const a = analyzeSeries('db', 'id', series(100, 100, 100, 100, 100, 100, 100, 110), 1, 0)
    expect(a.flagged).toBe(true) // 110 > max(1×100, 0)
  })
})
