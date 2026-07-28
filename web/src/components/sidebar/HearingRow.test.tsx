import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { HearingRow } from './HearingRow'
import { fontWeight } from '../../styles/tokens'
import type { HearingGroup } from './types'

// A far-future Tuesday so the date is never "TODAY" when tests run.
const hearing: HearingGroup = {
  hearingKey: 'h1', eventHash: 'abc', type: 'Committee hearing',
  date: '2027-03-09', time: '10:00', location: 'Room 412',
  description: 'Judiciary Committee hearing',
  bills: [{ id: 'b1', billNumber: 'H 100', title: 'Elections Act', summary: null, priority: 'high', state: 'RI', sessionSlug: null, myVote: null }],
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
    // accentAmber #e8a33d → rgb(232, 163, 61) once jsdom serializes the inline color.
    expect(getComputedStyle(el).color).toBe('rgb(232, 163, 61)')
  })
})
