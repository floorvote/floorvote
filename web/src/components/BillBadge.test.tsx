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

  // draftSrLabel is the text half of the draft signal for the tight surfaces
  // that have no room for a visible DraftChip. The dashed border is pure
  // decoration to assistive tech, so without this the badge would carry no
  // "draft" information at all there.
  it('adds "draft" to the accessible name when isDraft + draftSrLabel', () => {
    const { container } = wrap(['RI'], <BillBadge billNumber="H 100" isDraft draftSrLabel />)
    expect(container.textContent).toMatch(/draft/i)
  })
  it('stays silent when draftSrLabel is omitted, so paired DraftChip call sites do not announce twice', () => {
    const { container } = wrap(['RI'], <BillBadge billNumber="H 100" isDraft />)
    expect(container.textContent).not.toMatch(/draft/i)
  })
  it('ignores draftSrLabel on a filed bill', () => {
    const { container } = wrap(['RI'], <BillBadge billNumber="H 100" draftSrLabel />)
    expect(container.textContent).not.toMatch(/draft/i)
  })
  // The label must cost no layout: these badges sit in fixed-width grid tracks
  // and nowrap chip rows where any real width would clip or wrap a neighbour.
  it('hides the draft label with clip-rect, not by taking space', () => {
    wrap(['RI'], <BillBadge billNumber="H 100" isDraft draftSrLabel />)
    const el = [...document.querySelectorAll('span')].find(s => /^,\s*draft$/i.test(s.textContent ?? ''))!
    expect(el).toBeTruthy()
    expect(el.style.position).toBe('absolute')
    expect(el.style.clip.replace(/px/g, "")).toBe("rect(0, 0, 0, 0)")
    // Never set `display` here: DraftChip.tsx documents why an inline display
    // that a stylesheet is supposed to own was a shipped bug.
    expect(el.style.display).toBe('')
  })
})
