import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { EventItem } from './EventItem'
import type { CalendarEvent } from '../../lib/calendarGrid'

const { demo } = vi.hoisted(() => ({ demo: { demoMode: false, demoLocked: false } }))
vi.mock('../../context/DemoContext', () => ({ useDemo: () => demo }))

const customConfirmed: CalendarEvent = {
  id: '3', uid: 'c', source: 'custom', billId: null, bills: [],
  date: '2999-01-03', time: '10:00', location: null, description: 'Policy meeting', details: null, url: null, status: 'confirmed',
}
const customCancelled: CalendarEvent = {
  id: '4', uid: 'd', source: 'custom', billId: null, bills: [],
  date: '2999-01-04', time: '14:00', location: null, description: 'Cancelled session', details: null, url: null, status: 'cancelled',
}

beforeEach(() => { demo.demoLocked = false })

function renderItem(event: CalendarEvent) {
  render(
    <MemoryRouter>
      <EventItem
        event={event}
        isPast={false}
        isAdmin={true}
        editing={false}
        billOptions={[]}
        onEdit={vi.fn()}
        onEditSave={vi.fn()}
        onEditCancel={vi.fn()}
        onDelete={vi.fn()}
        onRestore={vi.fn()}
      />
    </MemoryRouter>
  )
}

describe('EventItem demo gating', () => {
  it('enables Delete when not demo-locked', () => {
    renderItem(customConfirmed)
    expect(screen.getByRole('button', { name: /delete event/i })).not.toBeDisabled()
  })

  it('disables Delete in demo', () => {
    demo.demoLocked = true
    renderItem(customConfirmed)
    expect(screen.getByRole('button', { name: /delete event/i })).toBeDisabled()
  })

  it('enables Restore when not demo-locked', () => {
    renderItem(customCancelled)
    expect(screen.getByRole('button', { name: /restore event/i })).not.toBeDisabled()
  })

  it('disables Restore in demo', () => {
    demo.demoLocked = true
    renderItem(customCancelled)
    expect(screen.getByRole('button', { name: /restore event/i })).toBeDisabled()
  })

  it('leaves Edit enabled in demo (edit is gated at Save, not here)', () => {
    demo.demoLocked = true
    renderItem(customConfirmed)
    expect(screen.getByRole('button', { name: /edit event/i })).not.toBeDisabled()
  })
})
