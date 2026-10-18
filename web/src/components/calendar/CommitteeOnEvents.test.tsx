import { describe, it, expect, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { AgendaView } from './AgendaView'
import { MonthGrid } from './MonthGrid'
import type { CalendarEvent } from '../../lib/calendarGrid'

// The committee on every body event (#695), in the agenda and the month grid.
// Both read the same fields GET /calendar/events sends, so the two views are
// held to the same fixtures.

vi.mock('../../lib/calendarGrid', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/calendarGrid')>()
  return { ...actual, todayIso: () => '2026-06-15' }
})

const base = { eventHash: null, billId: null, bills: [], time: null, location: null, details: null, url: null, status: 'confirmed' as const }
const BILL = { id: 'b1', billNumber: 'B26-0101', billTitle: 'Juvenile Records Act', state: 'DC', priority: 'high' as const, isDraft: false }

const health: CalendarEvent = {
  ...base, id: 'e1', uid: 'u1', source: 'body', date: '2026-06-16', description: 'Budget oversight roundtable',
  committee: 'Committee on Health', committeeId: 'c-health', jointWith: null, bodyState: 'DC', shownByPriority: false,
}
const jointEvent: CalendarEvent = {
  ...base, id: 'e2', uid: 'u2', source: 'body', date: '2026-06-17', description: 'Joint hearing on navigation',
  committee: 'Committee on Health', committeeId: 'c-health', jointWith: 'Committee on Housing', bodyState: 'DC', shownByPriority: false,
}
const noCommittee: CalendarEvent = {
  ...base, id: 'e3', uid: 'u3', source: 'body', date: '2026-06-18', description: 'Legislative meeting',
  committee: null, committeeId: null, jointWith: null, bodyState: 'DC', shownByPriority: false,
}
const custom: CalendarEvent = { ...base, id: 'e4', uid: 'u4', source: 'custom', date: '2026-06-19', description: 'Board meeting' }
const pinned: CalendarEvent = {
  ...base, id: 'e5', uid: 'u5', source: 'body', date: '2026-06-22', description: 'Markup of the Juvenile Records Act',
  committee: 'Committee on the Judiciary and Public Safety', committeeId: 'c-jps', jointWith: null, bodyState: 'DC', shownByPriority: true, bills: [BILL],
}
const withBill: CalendarEvent = { ...health, id: 'e6', uid: 'u6', date: '2026-06-23', description: 'Hearing with a bill', bills: [BILL] }
const whole: CalendarEvent = { ...health, id: 'e7', uid: 'u7', date: '2026-06-24', description: 'Legislative session', committee: 'Committee of the Whole', committeeId: 'c-cow' }
const maryland: CalendarEvent = { ...health, id: 'e8', uid: 'u8', date: '2026-06-25', description: 'Finance hearing', committee: 'Senate Finance Committee', committeeId: 'c-fin', bodyState: 'MD' }

const renderAgenda = (events: CalendarEvent[]) => render(
  <MemoryRouter>
    <AgendaView events={events} isAdmin={false} onEdit={vi.fn()} onDelete={vi.fn()} onRestore={vi.fn()} loaded headerHeight={0}
      billOptions={[]} editingId={null} onEditSave={vi.fn()} onEditCancel={vi.fn()} />
  </MemoryRouter>,
)
const renderMonth = (events: CalendarEvent[]) => render(
  <MemoryRouter><MonthGrid events={events} initialYear={2026} initialMonth={5} onSelect={vi.fn()} /></MemoryRouter>,
)
const agendaCard = (id: string) => document.getElementById(`agenda-event-${id}`) as HTMLElement
const monthCard = (text: string) => [...document.querySelectorAll('button')].find(b => b.textContent?.includes(text)) as HTMLElement

describe('the agenda card (#695)', () => {
  it('shows the committee under the title of a body event', () => {
    renderAgenda([health])
    const card = agendaCard('e1')
    expect(within(card).getByText('Committee on Health')).toBeInTheDocument()
    const title = within(card).getByText('Budget oversight roundtable')
    const tag = within(card).getByText('Committee on Health')
    expect(title.compareDocumentPosition(tag) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('says "jointly with" the other committee of a joint meeting', () => {
    renderAgenda([jointEvent])
    expect(within(agendaCard('e2')).getByText('Committee on Health')).toBeInTheDocument()
    expect(within(agendaCard('e2')).getByText(/jointly with Housing/)).toBeInTheDocument()
  })

  it('shows no committee line, and no "jointly with", for an event with no committee', () => {
    renderAgenda([noCommittee])
    const card = agendaCard('e3')
    expect(within(card).getByText('Legislative meeting')).toBeInTheDocument()
    expect(card.textContent).not.toMatch(/committee|jointly/i)
  })

  it('shows no committee line on an event that is not a body event', () => {
    renderAgenda([custom])
    expect(agendaCard('e4').textContent).not.toMatch(/committee|jointly|Shown:/i)
  })

  it('carries the "Shown: prioritized bill" chip only on an event the rules hide that a prioritized bill brings back', () => {
    renderAgenda([health, pinned])
    expect(within(agendaCard('e5')).getByText('Shown: prioritized bill')).toBeInTheDocument()
    expect(within(agendaCard('e1')).queryByText('Shown: prioritized bill')).not.toBeInTheDocument()
  })

  it('shows the chip even when the event has no committee', () => {
    renderAgenda([{ ...noCommittee, shownByPriority: true }])
    expect(within(agendaCard('e3')).getByText('Shown: prioritized bill')).toBeInTheDocument()
  })
})

describe('the month cell (#695)', () => {
  it('shows "DC · Health" on the first line, the state and the committee\'s short name', () => {
    renderMonth([health])
    const card = monthCard('Budget oversight roundtable')
    expect(within(card).getByText('DC · Health')).toBeInTheDocument()
    expect(card.textContent!.indexOf('DC · Health')).toBeLessThan(card.textContent!.indexOf('Budget oversight roundtable'))
  })

  it('keeps a name that has no "Committee on" to drop, and names the state of each event', () => {
    renderMonth([whole, maryland])
    expect(within(monthCard('Legislative session')).getByText('DC · Committee of the Whole')).toBeInTheDocument()
    expect(within(monthCard('Finance hearing')).getByText('MD · Senate Finance Committee')).toBeInTheDocument()
  })

  it('shows no tag for an event with no committee, and none for a custom event', () => {
    renderMonth([noCommittee, custom])
    expect(monthCard('Legislative meeting').textContent).not.toMatch(/DC ·/)
    expect(monthCard('Board meeting').textContent).not.toMatch(/·/)
  })

  it('keeps the bill chip in the cell beside the committee line, not pushed out', () => {
    renderMonth([withBill])
    const card = monthCard('Hearing with a bill')
    expect(within(card).getByText('DC · Health')).toBeInTheDocument()
    expect(within(card).getByText(/B26-0101/)).toBeInTheDocument()
  })

  it('makes room for the committee line: a card with one is taller than one without', () => {
    renderMonth([health, custom])
    const tall = parseFloat(monthCard('Budget oversight roundtable').style.height)
    const plain = parseFloat(monthCard('Board meeting').style.height)
    expect(tall).toBeGreaterThan(plain)
  })

  it('marks an event a prioritized bill brings back, for a screen reader', () => {
    renderMonth([pinned, health])
    expect(within(monthCard('Markup of the Juvenile Records Act')).getByLabelText('Shown: prioritized bill')).toBeInTheDocument()
    expect(within(monthCard('Budget oversight roundtable')).queryByLabelText('Shown: prioritized bill')).not.toBeInTheDocument()
  })
})

describe('the agenda and the month grid agree (#695)', () => {
  it.each([
    ['a committee event', health, 'Committee on Health', 'DC · Health'],
    ['a joint committee meeting', jointEvent, 'Committee on Health', 'DC · Health'],
  ])('both show the committee of %s', (_name, ev, agendaText, monthText) => {
    const a = renderAgenda([ev])
    expect(within(agendaCard(ev.id)).getByText(agendaText)).toBeInTheDocument()
    a.unmount()
    renderMonth([ev])
    expect(within(monthCard(ev.description!)).getByText(monthText)).toBeInTheDocument()
  })

  it('both show nothing for an event with no committee', () => {
    const a = renderAgenda([noCommittee])
    expect(agendaCard('e3').textContent).not.toMatch(/committee/i)
    a.unmount()
    renderMonth([noCommittee])
    expect(monthCard('Legislative meeting').textContent).not.toMatch(/·/)
  })

  it('both mark the prioritized-bill event', () => {
    const a = renderAgenda([pinned])
    expect(within(agendaCard('e5')).getByText('Shown: prioritized bill')).toBeInTheDocument()
    a.unmount()
    renderMonth([pinned])
    expect(within(monthCard('Markup of the Juvenile Records Act')).getByLabelText('Shown: prioritized bill')).toBeInTheDocument()
  })
})
