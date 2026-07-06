import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { AgendaView } from './AgendaView'
import type { CalendarEvent } from '../../lib/calendarGrid'

const evs: CalendarEvent[] = [
  { id: '1', uid: 'a', source: 'hearing', billId: 'b1', bills: [{ id: 'b1', billNumber: 'H 100', billTitle: 't', state: 'RI', priority: 'high' }], date: '2999-06-09', time: '09:00', location: null, description: 'Future', details: null, url: null, status: 'confirmed' },
]

const render0 = (events: CalendarEvent[]) =>
  render(
    <MemoryRouter>
      <AgendaView
        events={events}
        isAdmin={false}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onRestore={vi.fn()}
        loaded={true}
        headerHeight={0}
        billOptions={[]}
        editingId={null}
        onEditSave={vi.fn()}
        onEditCancel={vi.fn()}
      />
    </MemoryRouter>
  )

describe('AgendaView', () => {
  it('always shows a TODAY header even with no events today', () => {
    render0(evs)
    expect(screen.getByText(/^TODAY,/)).toBeInTheDocument()
  })
  it('keeps the empty-state TODAY header when there are no events at all', () => {
    render0([])
    expect(screen.getByText(/^TODAY,/)).toBeInTheDocument()
  })
  it('flashes the focused event and reports the focus as handled', () => {
    const onFocusHandled = vi.fn()
    const { container } = render(
      <MemoryRouter>
        <AgendaView
          events={evs}
          isAdmin={false}
          onEdit={vi.fn()}
          onDelete={vi.fn()}
          onRestore={vi.fn()}
          loaded={true}
          headerHeight={0}
          billOptions={[]}
          editingId={null}
          onEditSave={vi.fn()}
          onEditCancel={vi.fn()}
          focusEventId="1"
          onFocusHandled={onFocusHandled}
        />
      </MemoryRouter>
    )
    expect(onFocusHandled).toHaveBeenCalled()
    const card = container.querySelector('#agenda-event-1') as HTMLElement
    expect(card).toBeTruthy()
    expect(card.style.boxShadow).toContain('#fde68a')
  })
})
