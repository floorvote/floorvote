import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { ConfigContext, type AppConfig } from '../../context/ConfigContext'
import { CalendarEventsMoved } from './CalendarEventsMoved'

// Settings → Calendar events is gone (#420): the choice lives on the Calendar
// page. An old link to the settings page still lands somewhere that says so.

vi.mock('../../hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'u1', role: 'admin' } }) }))

function renderPage(capabilities: AppConfig['capabilities']) {
  return render(
    <ConfigContext value={{ config: { states: ['DC'], capabilities }, multiState: false, loading: false }}>
      <MemoryRouter><CalendarEventsMoved /></MemoryRouter>
    </ConfigContext>,
  )
}

describe('the old Settings → Calendar events page', () => {
  it('points to the Calendar page in one line', () => {
    renderPage({ DC: { bodyEvents: true, deadlines: true, bodyName: 'Council' } })
    const link = screen.getByRole('link', { name: 'Calendar page' })
    expect(link).toHaveAttribute('href', '/calendar')
    expect(link.parentElement).toHaveTextContent('Which Council events show is now chosen on the Calendar page.')
  })

  it('has no settings form: no radios, checkboxes, or Save', () => {
    renderPage({ DC: { bodyEvents: true, deadlines: true } })
    expect(screen.queryByRole('radio')).not.toBeInTheDocument()
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument()
  })

  it('does not point to a control that is not there when no covered state publishes its own calendar', () => {
    renderPage({ MD: { bodyEvents: false, deadlines: true } })
    expect(screen.queryByRole('link', { name: 'Calendar page' })).not.toBeInTheDocument()
    expect(screen.getByText(/nothing to choose/i)).toBeInTheDocument()
  })
})
