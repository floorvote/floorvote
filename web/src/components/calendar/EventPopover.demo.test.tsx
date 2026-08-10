import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { EventPopoverContent } from './EventPopover'
import type { CalendarEvent } from '../../lib/calendarGrid'
import { ConfigContext, type AppConfig } from '../../context/ConfigContext'

const { demo } = vi.hoisted(() => ({ demo: { demoMode: false, demoLocked: false } }))
vi.mock('../../context/DemoContext', () => ({ useDemo: () => demo }))

const custom: CalendarEvent = {
  id: '2', uid: 'b', source: 'custom', billId: null, bills: [],
  date: '2999-01-02', time: null, location: null, description: 'Board meeting', details: null, url: null, status: 'confirmed',
}

beforeEach(() => { demo.demoLocked = false })

function wrap(ui: React.ReactNode) {
  const value = { config: { states: ['RI'] } as AppConfig, multiState: false, loading: false }
  return render(<MemoryRouter><ConfigContext.Provider value={value}>{ui}</ConfigContext.Provider></MemoryRouter>)
}

describe('EventPopoverContent demo gating', () => {
  it('enables Delete when not demo-locked', () => {
    wrap(<EventPopoverContent event={custom} isAdmin onEdit={vi.fn()} onDelete={vi.fn()} onRestore={vi.fn()} />)
    expect(screen.getByRole('button', { name: /delete event/i })).not.toBeDisabled()
  })

  it('disables Delete in demo', () => {
    demo.demoLocked = true
    wrap(<EventPopoverContent event={custom} isAdmin onEdit={vi.fn()} onDelete={vi.fn()} onRestore={vi.fn()} />)
    expect(screen.getByRole('button', { name: /delete event/i })).toBeDisabled()
  })

  it('disables Restore in demo', () => {
    demo.demoLocked = true
    const cancelled: CalendarEvent = { ...custom, status: 'cancelled' }
    wrap(<EventPopoverContent event={cancelled} isAdmin onEdit={vi.fn()} onDelete={vi.fn()} onRestore={vi.fn()} />)
    expect(screen.getByRole('button', { name: /restore event/i })).toBeDisabled()
  })

  it('leaves Edit enabled in demo', () => {
    demo.demoLocked = true
    wrap(<EventPopoverContent event={custom} isAdmin onEdit={vi.fn()} onDelete={vi.fn()} onRestore={vi.fn()} />)
    expect(screen.getByRole('button', { name: /edit event/i })).not.toBeDisabled()
  })
})
