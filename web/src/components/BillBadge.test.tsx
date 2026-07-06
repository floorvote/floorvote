import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { ConfigContext, type AppConfig } from '../context/ConfigContext'
import { BillBadge } from './BillBadge'

function wrap(states: string[], ui: React.ReactNode) {
  const value = { config: { states } as AppConfig, multiState: states.length > 1, loading: false }
  return render(<MemoryRouter><ConfigContext.Provider value={value}>{ui}</ConfigContext.Provider></MemoryRouter>)
}

describe('BillBadge', () => {
  it('shows state in multi-state instances', () => {
    wrap(['RI', 'NJ'], <BillBadge billNumber="H 100" state="RI" />)
    expect(screen.getByText(/RI/)).toBeInTheDocument()
  })
  it('hides state in single-state instances even when passed', () => {
    wrap(['RI'], <BillBadge billNumber="H 100" state="RI" />)
    expect(screen.queryByText(/RI/)).toBeNull()
    expect(screen.getByText(/H 100/)).toBeInTheDocument()
  })
  it('renders a link when `to` is provided', () => {
    wrap(['RI'], <BillBadge billNumber="H 100" to="/RI/2026/H100" />)
    expect(screen.getByRole('link')).toHaveAttribute('href', '/RI/2026/H100')
  })
  it('renders a plain span (no link) when `to` is absent', () => {
    wrap(['RI'], <BillBadge billNumber="H 100" />)
    expect(screen.queryByRole('link')).toBeNull()
  })
})
