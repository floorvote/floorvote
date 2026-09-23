/**
 * EventLines — draft marker
 *
 * The calendar's bill chips rendered a draft with the solid navy badge: the
 * event-bill shape carried no draft flag. GET /calendar/events now selects
 * bills.isDraft on both bill paths and emits `isDraft` on every event bill, and
 * this component passes it to BillBadge.
 *
 * Only custom events can reach a draft — hearing events are LegiScan-synced and
 * a draft has no LegiScan id — but a custom event can link any tenant bill, so
 * this is a real user-visible case, not a defensive one.
 *
 * The text signal is BillBadge's screen-reader label, not a visible chip, in
 * every variant including the roomy ones. This one component renders into the
 * month cell (a ~120px day column whose chip row is flexWrap: nowrap /
 * overflow: hidden — clipped by design), the agenda card and the day popover;
 * marking the word only where it fits would make a draft read as a draft in the
 * agenda and as a filed bill in the month grid, within one calendar.
 */
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { EventLines } from './EventLines'
import type { CalendarEvent } from '../../lib/calendarGrid'

function ev(isDraft: boolean): CalendarEvent {
  return {
    id: '1', uid: 'u', source: 'custom', billId: null,
    bills: [{ id: 'b', billNumber: 'D 1', billTitle: 'Pre-filed measure', state: 'RI', priority: 'high', isDraft }],
    date: '2026-06-16', time: '13:30', location: 'Room 412', description: 'Working session',
    details: null, url: null, status: 'confirmed',
  }
}

function renderLines(isDraft: boolean, compact: boolean) {
  return render(<MemoryRouter><EventLines event={ev(isDraft)} compact={compact} /></MemoryRouter>)
}

describe.each([
  ['full variant (agenda card, day popover)', false],
  ['compact variant (month cell)', true],
])('EventLines draft marker — %s', (_label, compact) => {
  it('renders the dashed badge for a draft bill', () => {
    renderLines(true, compact)
    const badge = screen.getByText('D 1')
    expect(/dashed/.test(badge.style.border)).toBe(true)
    expect(badge.style.background === 'transparent' || badge.style.background === '').toBe(true)
  })

  it('renders the solid badge for a filed bill', () => {
    renderLines(false, compact)
    expect(/dashed/.test(screen.getByText('D 1').style.border)).toBe(false)
  })

  it('names the draft in the badge accessible name, with no layout-consuming chip', () => {
    const { container } = renderLines(true, compact)
    expect(container.textContent).toMatch(/draft/i)
    expect(screen.queryByText('Draft')).toBeNull()
  })

  it('says nothing about drafts for a filed bill', () => {
    const { container } = renderLines(false, compact)
    expect(container.textContent).not.toMatch(/draft/i)
  })
})
