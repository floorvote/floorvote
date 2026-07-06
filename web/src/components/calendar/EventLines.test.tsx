import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { EventLines, eventBodyModel } from './EventLines'
import type { CalendarEvent } from '../../lib/calendarGrid'

function ev(o: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: '1', uid: 'a', source: 'hearing', billId: 'b',
    bills: [{ id: 'b', billNumber: 'H 100', billTitle: 'Elections Act', state: 'RI', priority: 'high' }],
    date: '2026-06-16', time: '13:30', location: 'Room 412', description: 'Judiciary hearing',
    details: null, url: null, status: 'confirmed',
    ...o,
  }
}

const base: CalendarEvent = {
  id: '1', uid: 'u', source: 'custom', billId: null, bills: [],
  date: '2026-05-14', time: null, location: null, description: 'Filing period',
  details: 'Through May 29\nStatute: W.S. 22-5-209', url: 'https://sos.example.gov',
  status: 'confirmed' as const,
}

it('shows details and link in the full variant', () => {
  render(<MemoryRouter><EventLines event={base} /></MemoryRouter>)
  expect(screen.getByText(/Statute: W.S. 22-5-209/)).toBeInTheDocument()
  // The link shows the URL with the scheme stripped (formatEventUrl); href is the real URL.
  expect(screen.getByRole('link', { name: 'sos.example.gov' })).toHaveAttribute('href', 'https://sos.example.gov')
})

it('hides full details and link in the compact variant, but shows first line as hint when no bills', () => {
  render(<MemoryRouter><EventLines event={base} compact /></MemoryRouter>)
  // Full details text is passed to the hint (visually clamped by CSS); URL is hidden.
  expect(screen.getByText(/Through May 29/)).toBeInTheDocument()
  expect(screen.queryByRole('link', { name: 'https://sos.example.gov' })).not.toBeInTheDocument()
})

it('hides the details hint in compact when bills are present', () => {
  render(<MemoryRouter><EventLines event={{ ...base, bills: ev().bills }} compact /></MemoryRouter>)
  expect(screen.queryByText('Through May 29')).not.toBeInTheDocument()
})

it('clamps details and toggles on click in the agenda card', () => {
  render(<MemoryRouter><EventLines event={base} clampDetails /></MemoryRouter>)
  const toggle = screen.getByRole('button', { name: /show more/i })
  fireEvent.click(toggle)
  expect(screen.getByRole('button', { name: /show less/i })).toBeInTheDocument()
})

it('does not show toggle for short single-line details', () => {
  const shortEvent = { ...base, details: 'ok' }
  render(<MemoryRouter><EventLines event={shortEvent} clampDetails /></MemoryRouter>)
  expect(screen.getByText('ok')).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: /show more/i })).not.toBeInTheDocument()
})

describe('eventBodyModel', () => {
  it('uses the description for line 1 and shows location on its own line (full)', () => {
    const m = eventBodyModel(ev(), false)
    expect(m.time).toBe('1:30p')
    expect(m.text).toBe('Judiciary hearing')
    expect(m.location).toBe('Room 412')
  })

  it('falls back to the bill title (not location) when there is no description, keeping location on its own line', () => {
    const m = eventBodyModel(ev({ description: null }), false)
    expect(m.text).toBe('Elections Act')
    expect(m.location).toBe('Room 412')
  })

  it('falls back to the bill title when there is no description or location', () => {
    const m = eventBodyModel(ev({ description: null, location: null }), false)
    expect(m.text).toBe('Elections Act')
    expect(m.location).toBeNull()
  })

  it('never shows a separate location line in compact (month) mode', () => {
    const m = eventBodyModel(ev(), true)
    expect(m.text).toBe('Judiciary hearing')
    expect(m.location).toBeNull()
  })

  it('flags cancelled', () => {
    expect(eventBodyModel(ev({ status: 'cancelled' }), false).cancelled).toBe(true)
  })
})

describe('EventLines — full variant stacked layout', () => {
  const full = (o: Partial<CalendarEvent> = {}) =>
    render(<MemoryRouter><EventLines event={ev({ url: 'https://www.rilegislature.gov/hearings', details: 'Agenda: testimony', ...o })} /></MemoryRouter>)

  it('stacks title, then schedule/location/link icon lines in order, details last', () => {
    const { container } = full()
    const tc = container.textContent ?? ''
    expect(tc.indexOf('Judiciary hearing')).toBeLessThan(tc.indexOf('schedule'))
    expect(tc.indexOf('schedule')).toBeLessThan(tc.indexOf('location_on'))
    expect(tc.indexOf('location_on')).toBeLessThan(tc.indexOf('link_2'))
    expect(tc.indexOf('link_2')).toBeLessThan(tc.indexOf('Agenda: testimony'))
  })

  it('renders the schedule, location_on, and link_2 meta icons', () => {
    full()
    expect(screen.getByText('schedule')).toBeInTheDocument()
    expect(screen.getByText('location_on')).toBeInTheDocument()
    expect(screen.getByText('link_2')).toBeInTheDocument()
  })

  it('shows the link with scheme + www stripped but links to the real URL', () => {
    full()
    const a = screen.getByRole('link', { name: 'rilegislature.gov/hearings' })
    expect(a).toHaveAttribute('href', 'https://www.rilegislature.gov/hearings')
  })
})
