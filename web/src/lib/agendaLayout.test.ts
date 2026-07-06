import { describe, it, expect } from 'vitest'
import { computeSpacerHeight, agendaFooterLabel } from './agendaLayout'
import type { CalendarEvent } from './calendarGrid'

const ev = (date: string | null): CalendarEvent => ({
  id: date ?? 'x', uid: 'u', source: 'hearing', billId: null, bills: [],
  date, time: null, location: null, description: 'e', details: null, url: null, status: 'confirmed',
})

describe('computeSpacerHeight', () => {
  it('fills the gap when content below today is short', () => {
    // viewport 800, header 120 → 680 available; content below today is 200 → spacer 480
    expect(computeSpacerHeight(800, 120, 200)).toBe(480)
  })
  it('is zero when content below today already exceeds the viewport', () => {
    expect(computeSpacerHeight(800, 120, 900)).toBe(0)
  })
  it('never returns negative', () => {
    expect(computeSpacerHeight(800, 120, 5000)).toBe(0)
  })
})

describe('agendaFooterLabel', () => {
  it('reports no upcoming events when nothing is dated today or later', () => {
    expect(agendaFooterLabel([ev('2026-06-01'), ev('2026-05-30')], '2026-06-06')).toBe('No upcoming events')
  })
  it('reports end of agenda when something is dated today or later', () => {
    expect(agendaFooterLabel([ev('2026-06-01'), ev('2026-06-09')], '2026-06-06')).toBe('End of agenda')
    expect(agendaFooterLabel([ev('2026-06-06')], '2026-06-06')).toBe('End of agenda')
  })
  it('ignores events with no date', () => {
    expect(agendaFooterLabel([ev(null)], '2026-06-06')).toBe('No upcoming events')
  })
})
