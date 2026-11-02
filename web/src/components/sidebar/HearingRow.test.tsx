import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { HearingRow } from './HearingRow'
import { color, fontWeight } from '../../styles/tokens'
import type { HearingGroup } from './types'

// A far-future Tuesday so the date is never "TODAY" when tests run.
const hearing: HearingGroup = {
  hearingKey: 'h1', eventHash: 'abc', type: 'Committee hearing',
  date: '2027-03-09', time: '10:00', location: 'Room 412',
  description: 'Judiciary Committee hearing',
  bills: [{ id: 'b1', billNumber: 'H 100', title: 'Elections Act', summary: null, priority: 'high', state: 'RI', sessionSlug: null, myVote: null, isDraft: false }],
}

function renderRow(h: HearingGroup) {
  return render(<MemoryRouter><HearingRow hearing={h} isFirst onClose={() => {}} /></MemoryRouter>)
}

describe('HearingRow date/time format', () => {
  it('shows the short weekday (uppercased via DateLabel), matching the calendar', () => {
    renderRow(hearing)
    // formatDateHeader → "Tue, Mar 9"; DateLabel uppercases via CSS, so the text node is "Tue, Mar 9".
    expect(screen.getByText('Tue, Mar 9')).toBeInTheDocument()
    // Not the full-weekday form.
    expect(screen.queryByText(/Tuesday/)).toBeNull()
  })

  it('uses the compact time form ("10a"), not the long "10:00 AM"', () => {
    renderRow(hearing)
    expect(screen.getByText(/10a/)).toBeInTheDocument()
    expect(screen.queryByText(/10:00 AM/)).toBeNull()
  })

  it('renders the time in a lighter weight than the (semibold) date', () => {
    renderRow(hearing)
    const timeEl = screen.getByText(/· 10a/)
    expect(timeEl.style.fontWeight).toBe(String(fontWeight.normal))
  })

  it('renders the description in the agenda title style — sans, not serif', () => {
    renderRow(hearing)
    const desc = screen.getByText('Judiciary Committee hearing')
    // serif is reserved for bill names/summaries; the hearing description is sans.
    expect(desc.style.fontFamily).not.toMatch(/serif/i)
  })

  it('colors the date amber when the hearing is today', () => {
    const todayIso = new Date().toLocaleDateString('en-CA') // YYYY-MM-DD, local
    renderRow({ ...hearing, date: todayIso })
    const el = screen.getByText(/TODAY,/) // formatTodayHeader → "TODAY, JUN N"
    expect(el.style.color).toBe(color.accentAmber)
  })
})

// The bill chips fold behind the shared count toggle: a "+N more" link, no chevron.
describe('HearingRow bill chips fold', () => {
  const bill = (n: number) => ({
    id: `b${n}`, billNumber: `H ${100 + n}`, title: `Act ${n}`, summary: null, priority: 'high' as const,
    state: 'RI', sessionSlug: null, myVote: null, isDraft: false,
  })
  const withBills = (n: number): HearingGroup => ({ ...hearing, bills: Array.from({ length: n }, (_, i) => bill(i)) })
  const chipLinks = () => screen.getAllByRole('link').filter(a => a.getAttribute('href')?.includes('#section-hearings'))

  it('shows six chips and a "+N more" toggle with the right N, with no chevron', () => {
    renderRow(withBills(9))
    expect(chipLinks()).toHaveLength(6)
    const btn = screen.getByRole('button', { name: '+3 more' })
    expect(btn).toHaveAttribute('aria-expanded', 'false')
    expect(btn.querySelector('[data-fold-chevron]')).toBeNull()
  })

  it('opens every chip on click and relabels the toggle "Show less"; a second click folds back', () => {
    renderRow(withBills(9))
    fireEvent.click(screen.getByRole('button', { name: '+3 more' }))
    expect(chipLinks()).toHaveLength(9)
    expect(screen.getByRole('button', { name: 'Show less' })).toHaveAttribute('aria-expanded', 'true')
    fireEvent.click(screen.getByRole('button', { name: 'Show less' }))
    expect(chipLinks()).toHaveLength(6)
    expect(screen.getByRole('button', { name: '+3 more' })).toBeInTheDocument()
  })

  it('renders no toggle when the chips fit under the cap', () => {
    renderRow(withBills(6))
    expect(chipLinks()).toHaveLength(6)
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('styles the toggle as the link, not as a gray chip', () => {
    renderRow(withBills(8))
    const btn = screen.getByRole('button', { name: '+2 more' })
    expect(btn.style.color).toBe(color.linkBlue)
    expect(btn.style.fontSize).toBe('12px')
    expect(btn.style.background === '' || btn.style.background === 'none').toBe(true)
  })

  it('puts the toggle on its own line under the chip row', () => {
    renderRow(withBills(8))
    const btn = screen.getByRole('button', { name: '+2 more' })
    const row = chipLinks()[0].parentElement as HTMLElement
    expect(row.contains(btn)).toBe(false)
  })

  it('does not open the agenda when the toggle is clicked', () => {
    renderRow(withBills(8))
    const notPrevented = fireEvent.click(screen.getByRole('button', { name: '+2 more' }))
    expect(notPrevented).toBe(false)
  })
})
