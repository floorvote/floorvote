import { describe, it, expect, vi, afterEach } from 'vitest'
import { buildMonthMatrix, bucketEventsByDate, isPastDate, todayIso, type CalendarEvent } from './calendarGrid'
import { epochToLocalDay } from '../../../shared/time'

describe('buildMonthMatrix', () => {
  it('returns weeks of 7 days covering the month, Sunday-first', () => {
    // June 2026: 1st is a Monday; 30 days.
    const weeks = buildMonthMatrix(2026, 5) // month is 0-indexed (5 = June)
    expect(weeks[0]).toHaveLength(7)
    expect(weeks.flat().length % 7).toBe(0)
    // First cell is the Sunday before/at the 1st (2026-05-31).
    expect(weeks[0][0].iso).toBe('2026-05-31')
    expect(weeks[0][0].inMonth).toBe(false)
    // The 1st sits in column 1 (Monday).
    const first = weeks.flat().find(d => d.iso === '2026-06-01')!
    expect(first.inMonth).toBe(true)
  })

  // Boundary months: the grid must always contain every day of the target month
  // as inMonth=true, in whole Sunday-first weeks. Guards the spillover logic.
  it.each([
    { label: 'Feb 2026 (1st = Sunday, min spillover)', year: 2026, month: 1, days: 28 },
    { label: 'Oct 2022 (1st = Saturday, max spillover, needs 6 rows)', year: 2022, month: 9, days: 31 },
    { label: 'Nov 2026 (1st = Sunday)', year: 2026, month: 10, days: 30 },
  ])('covers all days for $label', ({ year, month, days }) => {
    const weeks = buildMonthMatrix(year, month)
    expect(weeks.flat().length % 7).toBe(0) // whole weeks only
    // Every day 1..days of the target month is present exactly once with inMonth=true.
    const inMonth = weeks.flat().filter(d => d.inMonth)
    expect(inMonth).toHaveLength(days)
    for (let day = 1; day <= days; day++) {
      const iso = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
      const cell = weeks.flat().find(d => d.iso === iso)
      expect(cell?.inMonth).toBe(true)
    }
    // Grid starts on a Sunday.
    expect(new Date(`${weeks[0][0].iso}T00:00:00`).getDay()).toBe(0)
  })
})

describe('date helpers', () => {
  afterEach(() => vi.useRealTimers())

  it('isPastDate is true for dates before today, false for today/future', () => {
    const today = todayIso()
    expect(isPastDate('2000-01-01', today)).toBe(true)
    expect(isPastDate(today, today)).toBe(false)
    expect(isPastDate('2999-01-01', today)).toBe(false)
  })

  it('todayIso uses the viewer local calendar day, not the UTC day', () => {
    // Freeze at an instant that is already the next calendar day in UTC but the
    // prior evening in the Americas (00:30 UTC). todayIso must track the local
    // day (epochToLocalDay), never `new Date().toISOString().slice(0,10)`, or the
    // agenda labels tomorrow as "TODAY" for evening users west of UTC.
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-09T00:30:00Z'))
    expect(todayIso()).toBe(epochToLocalDay(Date.now()))
  })
})

describe('bucketEventsByDate', () => {
  it('groups events by their date string', () => {
    const evs: CalendarEvent[] = [
      { id: '1', uid: 'a', source: 'hearing', billId: 'b1', bills: [{ id: 'b1', billNumber: 'H1', billTitle: 't', state: null, priority: 'high' }], date: '2026-06-02', time: '14:00', location: null, description: 'x', details: null, url: null, status: 'confirmed' },
      { id: '2', uid: 'b', source: 'custom', billId: null, bills: [], date: '2026-06-02', time: null, location: null, description: 'y', details: null, url: null, status: 'confirmed' },
      { id: '3', uid: 'c', source: 'hearing', billId: 'b2', bills: [{ id: 'b2', billNumber: 'H2', billTitle: 't', state: null, priority: 'low' }], date: '2026-06-09', time: null, location: null, description: 'z', details: null, url: null, status: 'confirmed' },
    ]
    const map = bucketEventsByDate(evs)
    expect(map.get('2026-06-02')).toHaveLength(2)
    expect(map.get('2026-06-09')).toHaveLength(1)
  })

  it('orders each day chronologically, with all-day (timeless) events first', () => {
    const evs: CalendarEvent[] = [
      { id: 'pm', uid: 'a', source: 'custom', billId: null, bills: [], date: '2026-06-02', time: '16:00', location: null, description: 'afternoon', details: null, url: null, status: 'confirmed' },
      { id: 'am', uid: 'b', source: 'custom', billId: null, bills: [], date: '2026-06-02', time: '09:00', location: null, description: 'morning', details: null, url: null, status: 'confirmed' },
      { id: 'allday', uid: 'c', source: 'custom', billId: null, bills: [], date: '2026-06-02', time: null, location: null, description: 'all day', details: null, url: null, status: 'confirmed' },
    ]
    const ids = (bucketEventsByDate(evs).get('2026-06-02') ?? []).map(e => e.id)
    expect(ids).toEqual(['allday', 'am', 'pm'])
  })
})
