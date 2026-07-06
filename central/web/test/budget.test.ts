import { describe, it, expect } from 'vitest'
import { utcDayOfMonth, cumulativeFromDaily, computePace, build90DayPoints } from '../src/lib/budget'

describe('utcDayOfMonth', () => {
  it('parses day from YYYY-MM-DD', () => {
    expect(utcDayOfMonth('2026-06-01')).toBe(1)
    expect(utcDayOfMonth('2026-06-15')).toBe(15)
    expect(utcDayOfMonth('2026-06-30')).toBe(30)
  })
})

describe('cumulativeFromDaily', () => {
  it('returns empty for empty input', () => {
    expect(cumulativeFromDaily([])).toEqual([])
  })

  it('computes running sum', () => {
    const result = cumulativeFromDaily([
      { date: '2026-06-01', value: 10 },
      { date: '2026-06-02', value: 5 },
      { date: '2026-06-03', value: 20 },
    ])
    expect(result).toEqual([
      { day: 1, value: 10 },
      { day: 2, value: 15 },
      { day: 3, value: 35 },
    ])
  })

  it('uses utc day-of-month for day field', () => {
    const result = cumulativeFromDaily([{ date: '2026-06-17', value: 7 }])
    expect(result[0].day).toBe(17)
  })
})

describe('computePace', () => {
  it('returns zeros when monthElapsed is 0', () => {
    const pace = computePace({ used: 0, limit: 30000, monthElapsed: 0 })
    expect(pace.expectedByNow).toBe(0)
    expect(pace.projected).toBe(0)
    expect(pace.pacePct).toBe(0)
  })

  it('computes correct pace at midpoint', () => {
    // 50% through month, 15000 used of 30000 limit → on pace
    const pace = computePace({ used: 15000, limit: 30000, monthElapsed: 0.5 })
    expect(pace.expectedByNow).toBe(15000) // round(30000 * 0.5)
    expect(pace.pacePct).toBe(100)          // 15000 / 15000 * 100
    expect(pace.projected).toBe(30000)      // round(15000 / 0.5)
    expect(pace.monthPct).toBe(50)          // round(0.5 * 100)
  })

  it('pacePct > 100 when over pace', () => {
    const pace = computePace({ used: 20000, limit: 30000, monthElapsed: 0.5 })
    expect(pace.pacePct).toBeGreaterThan(100)
  })

  it('rounds all output values', () => {
    const pace = computePace({ used: 1000, limit: 30000, monthElapsed: 1/3 })
    expect(Number.isInteger(pace.expectedByNow)).toBe(true)
    expect(Number.isInteger(pace.projected)).toBe(true)
    expect(Number.isInteger(pace.pacePct)).toBe(true)
    expect(Number.isInteger(pace.monthPct)).toBe(true)
  })
})

describe('build90DayPoints', () => {
  it('returns 90 entries', () => {
    const result = build90DayPoints([], 30000, 'increments')
    expect(result).toHaveLength(90)
  })

  it('each entry has date, actual, and budget fields', () => {
    const result = build90DayPoints([], 30000, 'increments')
    const first = result[0]
    expect(typeof first.date).toBe('string')
    expect(first.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect('actual' in first).toBe(true)
    expect('budget' in first).toBe(true)
  })

  it('increments mode: accumulates daily values within month, resets on month boundary', () => {
    // Build a synthetic 90-day input with known values
    const today = new Date()
    const startDate = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - 89))
    // Put 5 on each of the first two days
    const d0 = startDate.toISOString().slice(0, 10)
    const d1 = new Date(Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth(), startDate.getUTCDate() + 1)).toISOString().slice(0, 10)
    const result = build90DayPoints(
      [{ date: d0, value: 5 }, { date: d1, value: 10 }],
      30000,
      'increments',
    )
    // First entry: cumulative = 5
    expect(result[0].actual).toBe(5)
    // Second entry: cumulative = 15 (only if same month as first), or 10 (if different month)
    const sameMonth = d0.slice(0, 7) === d1.slice(0, 7)
    expect(result[1].actual).toBe(sameMonth ? 15 : 10)
  })

  it('increments mode: resets cumulative to 0 at start of new month', () => {
    // Find the first day of current month — that's a known reset boundary within 90 days
    const today = new Date()
    const firstOfMonth = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1))
    const firstOfMonthStr = firstOfMonth.toISOString().slice(0, 10)
    // Give day before month start some value, and day of month start some value
    const dayBeforeStr = new Date(Date.UTC(firstOfMonth.getUTCFullYear(), firstOfMonth.getUTCMonth(), 0)).toISOString().slice(0, 10)
    const result = build90DayPoints(
      [{ date: dayBeforeStr, value: 100 }, { date: firstOfMonthStr, value: 50 }],
      30000,
      'increments',
    )
    const monthStartEntry = result.find(p => p.date === firstOfMonthStr)
    // At the start of the month the cumulative resets, so the value is 50, not 150
    expect(monthStartEntry?.actual).toBe(50)
  })

  it('snapshots mode: uses value directly, null for missing days', () => {
    const today = new Date()
    const todayStr = today.toISOString().slice(0, 10)
    const result = build90DayPoints(
      [{ date: todayStr, value: 2500 }],
      3000,
      'snapshots',
    )
    const todayEntry = result.find(p => p.date === todayStr)
    expect(todayEntry?.actual).toBe(2500)
    // A day with no reading should be null
    const firstEntry = result[0]
    if (firstEntry.date !== todayStr) {
      expect(firstEntry.actual).toBeNull()
    }
  })

  it('budget value equals proportional limit for that day in the month', () => {
    const result = build90DayPoints([], 30000, 'increments')
    // Find today's entry — its budget value should be round(limit * dayOfMonth / daysInMonth)
    const today = new Date()
    const todayStr = today.toISOString().slice(0, 10)
    const todayEntry = result.find(p => p.date === todayStr)!
    const dayOfMonth = today.getUTCDate()
    const daysInMonth = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 0)).getUTCDate()
    expect(todayEntry.budget).toBe(Math.round(30000 * dayOfMonth / daysInMonth))
  })
})
