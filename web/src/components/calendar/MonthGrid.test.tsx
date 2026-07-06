import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { MonthGrid } from './MonthGrid'
import type { CalendarEvent } from '../../lib/calendarGrid'
import { ConfigContext, type AppConfig } from '../../context/ConfigContext'

// Pin "today" to an in-month June 2026 day so today-styling is deterministic.
vi.mock('../../lib/calendarGrid', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/calendarGrid')>()
  return { ...actual, todayIso: () => '2026-06-15' }
})

// jsdom serializes inline colors to rgb(); these match the tokens used for edges.
const NAVY_RGB = 'rgb(30, 58, 95)'   // color.billBadgeNavy #1e3a5f
const BLUE_RGB = 'rgb(59, 130, 246)' // color.accentBlue   #3b82f6

const AMBER_RGB = 'rgb(245, 158, 11)'        // color.accentAmber
const AMBER_FILL_RGB = 'rgb(254, 243, 199)'  // color.bgAmberPriority
const BORDER_RGB = 'rgb(226, 232, 240)'      // color.borderDefault

const evs: CalendarEvent[] = [
  { id: '1', uid: 'a', source: 'custom', billId: null, bills: [], date: '2026-06-15', time: null, location: null, description: 'Board meeting', details: null, url: null, status: 'confirmed' },
]

const billEvent: CalendarEvent = {
  id: '2', uid: 'b', source: 'hearing', billId: 'bb',
  bills: [{ id: 'bb', billNumber: 'H 100', billTitle: 'Elections', state: 'RI', priority: 'high' }],
  date: '2026-06-15', time: null, location: null, description: 'Hearing', details: null, url: null, status: 'confirmed',
}

function cardFor(text: string): HTMLElement | undefined {
  return [...document.querySelectorAll('button')].find(b => b.textContent?.includes(text))
}

describe('MonthGrid', () => {
  it('renders custom event description text in the cell', () => {
    render(<MemoryRouter><MonthGrid events={evs} initialYear={2026} initialMonth={5} onSelect={vi.fn()} /></MemoryRouter>)
    expect(screen.getByText('Board meeting')).toBeInTheDocument()
  })

  it('custom event card has a blue calendar source icon, no left border edge', () => {
    render(<MemoryRouter><MonthGrid events={evs} initialYear={2026} initialMonth={5} onSelect={vi.fn()} /></MemoryRouter>)
    const card = cardFor('Board meeting')
    expect(card?.style.borderLeft).not.toContain('3px solid')
    const icon = card?.querySelector('[role="img"]') as HTMLElement
    expect(icon.getAttribute('aria-label')).toBe('Custom event')
    expect(icon.textContent).toBe('calendar_today')
    expect(icon.style.color).toBe(BLUE_RGB)
  })

  it('hearing event card has a navy gavel source icon, no left border edge', () => {
    render(<MemoryRouter><MonthGrid events={[billEvent]} initialYear={2026} initialMonth={5} onSelect={vi.fn()} /></MemoryRouter>)
    const card = cardFor('H 100')
    expect(card?.style.borderLeft).not.toContain('3px solid')
    const icon = card?.querySelector('[role="img"]') as HTMLElement
    expect(icon.getAttribute('aria-label')).toBe('Hearing')
    expect(icon.textContent).toBe('gavel')
    expect(icon.style.color).toBe(NAVY_RGB)
  })

  it('custom event with a linked bill is STILL the custom icon (regression: source, not bill, decides the marker)', () => {
    const customWithBill: CalendarEvent = {
      id: '9', uid: 'z', source: 'custom', billId: null,
      bills: [{ id: 'bz', billNumber: 'S 9', billTitle: 'Linked', state: 'RI', priority: 'low' }],
      date: '2026-06-15', time: null, location: null, description: 'Strategy call', details: null, url: null, status: 'confirmed',
    }
    render(<MemoryRouter><MonthGrid events={[customWithBill]} initialYear={2026} initialMonth={5} onSelect={vi.fn()} /></MemoryRouter>)
    const card = cardFor('Strategy call')
    const icon = card?.querySelector('[role="img"]') as HTMLElement
    expect(icon.getAttribute('aria-label')).toBe('Custom event')
    expect(icon.style.color).toBe(BLUE_RGB)
    expect(icon.style.color).not.toBe(NAVY_RGB)
  })

  it('renders linked bills as chips in the month tile', () => {
    render(<MemoryRouter><MonthGrid events={[billEvent]} initialYear={2026} initialMonth={5} onSelect={vi.fn()} /></MemoryRouter>)
    expect(screen.getByText('H 100')).toBeInTheDocument()
  })

  it('shows the bill title alongside the badge on a bill card', () => {
    render(<MemoryRouter><MonthGrid events={[billEvent]} initialYear={2026} initialMonth={5} onSelect={vi.fn()} /></MemoryRouter>)
    // description is preferred as the headline; here it's "Hearing"
    expect(screen.getByText('Hearing')).toBeInTheDocument()
  })

  it('shows the state prefix on month chips (BillBadge gates display via multiState context)', () => {
    const value = { config: { states: ['RI', 'NJ'] } as AppConfig, multiState: true, loading: false }
    render(<MemoryRouter><ConfigContext.Provider value={value}><MonthGrid events={[billEvent]} initialYear={2026} initialMonth={5} onSelect={vi.fn()} /></ConfigContext.Provider></MemoryRouter>)
    expect(screen.getByText(/RI/)).toBeInTheDocument()
    expect(screen.getByText(/H 100/)).toBeInTheDocument()
  })

  it('caps cards at two and folds the rest into "+N more"', () => {
    const many: CalendarEvent[] = Array.from({ length: 5 }, (_, i) => ({
      id: String(i), uid: String(i), source: 'custom', billId: null, bills: [],
      date: '2026-06-15', time: null, location: null, description: `Event ${i}`, details: null, url: null, status: 'confirmed',
    }))
    render(<MemoryRouter><MonthGrid events={many} initialYear={2026} initialMonth={5} onSelect={vi.fn()} /></MemoryRouter>)
    expect(screen.getByText('Event 0')).toBeInTheDocument()
    expect(screen.getByText('Event 1')).toBeInTheDocument()
    expect(screen.queryByText('Event 2')).not.toBeInTheDocument()
    expect(screen.getByText('+3 more')).toBeInTheDocument()
  })

  it('calls onSelectDay with the full day list when "+N more" is clicked', () => {
    const many: CalendarEvent[] = Array.from({ length: 4 }, (_, i) => ({
      id: String(i), uid: String(i), source: 'custom', billId: null, bills: [],
      date: '2026-06-15', time: null, location: null, description: `Event ${i}`, details: null, url: null, status: 'confirmed',
    }))
    const onSelectDay = vi.fn()
    render(<MemoryRouter><MonthGrid events={many} initialYear={2026} initialMonth={5} onSelect={vi.fn()} onSelectDay={onSelectDay} /></MemoryRouter>)
    fireEvent.click(screen.getByText('+2 more'))
    expect(onSelectDay).toHaveBeenCalledTimes(1)
    const [dateIso, dayEvents, , alignRight] = onSelectDay.mock.calls[0]
    expect(dateIso).toBe('2026-06-15') // a Monday → left origin
    expect(dayEvents).toHaveLength(4)
    expect(alignRight).toBe(false)
  })

  it('passes alignRight=true for "+N more" on a Saturday cell', () => {
    const many: CalendarEvent[] = Array.from({ length: 3 }, (_, i) => ({
      id: String(i), uid: String(i), source: 'custom', billId: null, bills: [],
      date: '2026-06-27', time: null, location: null, description: `Event ${i}`, details: null, url: null, status: 'confirmed',
    }))
    const onSelectDay = vi.fn()
    render(<MemoryRouter><MonthGrid events={many} initialYear={2026} initialMonth={5} onSelect={vi.fn()} onSelectDay={onSelectDay} /></MemoryRouter>)
    fireEvent.click(screen.getByText('+1 more'))
    expect(onSelectDay.mock.calls[0][3]).toBe(true) // 2026-06-27 is a Saturday
  })

  it('passes alignRight to onSelect when a single event is clicked (Saturday → true)', () => {
    const satEvent: CalendarEvent = { ...billEvent, id: 'sat', date: '2026-06-27' }
    const onSelect = vi.fn()
    render(<MemoryRouter><MonthGrid events={[satEvent]} initialYear={2026} initialMonth={5} onSelect={onSelect} /></MemoryRouter>)
    fireEvent.click(cardFor('H 100')!)
    expect(onSelect.mock.calls[0][2]).toBe(true)
  })

  it('calls onAddEvent with the date when an in-month day is clicked', () => {
    const onAddEvent = vi.fn()
    render(<MemoryRouter><MonthGrid events={[]} initialYear={2026} initialMonth={5} onSelect={vi.fn()} onAddEvent={onAddEvent} /></MemoryRouter>)
    fireEvent.click(document.querySelector('[data-daycell="2026-06-15"]')!) // Monday
    expect(onAddEvent).toHaveBeenCalledTimes(1)
    expect(onAddEvent.mock.calls[0][0]).toBe('2026-06-15')
    expect(onAddEvent.mock.calls[0][3]).toBe(false) // alignRight moved to index 3
    onAddEvent.mockClear()
    fireEvent.click(document.querySelector('[data-daycell="2026-06-27"]')!) // Saturday
    expect(onAddEvent.mock.calls[0][3]).toBe(true)
  })

  it('passes the cell element as the third arg to onAddEvent', () => {
    const onAddEvent = vi.fn()
    const { container } = render(
      <MemoryRouter>
        <MonthGrid events={evs} initialYear={2026} initialMonth={5} onSelect={vi.fn()} onAddEvent={onAddEvent} />
      </MemoryRouter>,
    )
    // 2026-06-10 is a Wednesday in June 2026; evs only has an event on 2026-06-15, so this cell is empty
    const emptyCell = container.querySelector('[data-daycell="2026-06-10"]') as HTMLElement
    emptyCell.click()
    expect(onAddEvent).toHaveBeenCalled()
    const args = onAddEvent.mock.calls[0]
    expect(args[0]).toBe('2026-06-10')
    expect(args[2]).toBe(emptyCell) // new 3rd arg = cell element
  })

  it('does not call onAddEvent for out-of-month days', () => {
    const onAddEvent = vi.fn()
    // May 2026 grid leads with late-April days; click one of those out-of-month cells.
    render(<MemoryRouter><MonthGrid events={[]} initialYear={2026} initialMonth={4} onSelect={vi.fn()} onAddEvent={onAddEvent} /></MemoryRouter>)
    const cells = [...document.querySelectorAll('[data-daycell]')]
    const outOfMonth = cells.find(c => (c.getAttribute('data-daycell') ?? '').startsWith('2026-04'))
    fireEvent.click(outOfMonth!)
    expect(onAddEvent).not.toHaveBeenCalled()
  })

  it('marks the grid container and tags in-month cells for expand bounds', () => {
    const { container } = render(<MemoryRouter><MonthGrid events={evs} initialYear={2026} initialMonth={5} onSelect={vi.fn()} /></MemoryRouter>)
    // grid container is discoverable
    expect(container.querySelector('[data-calgrid]')).toBeTruthy()
    // every day cell carries an in-month flag (1 or 0)
    const cells = container.querySelectorAll('[data-daycell]')
    expect(cells.length).toBeGreaterThan(0)
    cells.forEach(c => {
      expect(['0', '1']).toContain(c.getAttribute('data-inmonth'))
    })
  })

  it('fills today with the pale amber highlight (not an amber border)', () => {
    const { container } = render(<MemoryRouter><MonthGrid events={evs} initialYear={2026} initialMonth={5} onSelect={vi.fn()} /></MemoryRouter>)
    const todayCell = container.querySelector('[data-daycell="2026-06-15"]') as HTMLElement
    expect(todayCell.style.background).toContain(AMBER_FILL_RGB)
    expect(todayCell.style.border).toContain(BORDER_RGB)
    expect(todayCell.style.border).not.toContain(AMBER_RGB)
  })

  it('outlines the active day with a 2px amber border', () => {
    const { container } = render(<MemoryRouter><MonthGrid events={evs} initialYear={2026} initialMonth={5} onSelect={vi.fn()} activeDateIso="2026-06-10" /></MemoryRouter>)
    const activeCell = container.querySelector('[data-daycell="2026-06-10"]') as HTMLElement
    expect(activeCell.style.border).toBe(`2px solid ${AMBER_RGB}`)
    const otherCell = container.querySelector('[data-daycell="2026-06-12"]') as HTMLElement
    expect(otherCell.style.border).toBe(`1px solid ${BORDER_RGB}`)
  })

  it('has no active outline when activeDateIso is null', () => {
    const { container } = render(<MemoryRouter><MonthGrid events={evs} initialYear={2026} initialMonth={5} onSelect={vi.fn()} activeDateIso={null} /></MemoryRouter>)
    const cells = Array.from(container.querySelectorAll('[data-daycell]')) as HTMLElement[]
    expect(cells.some(c => c.style.border.startsWith('2px'))).toBe(false)
  })
})
