import { describe, it, expect, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { EventPopoverContent } from './EventPopover'
import type { CalendarEvent } from '../../lib/calendarGrid'
import { ConfigContext, type AppConfig } from '../../context/ConfigContext'

// Companion groups on the calendar (#381): each member's hearing is its own
// entry, labeled by its bill, and the popover links to the group's bills (a
// bill's page is where the group's shared discussion is).

const senateHearing: CalendarEvent = {
  id: 'ev-s', uid: 'a', source: 'hearing', billId: 's1',
  bills: [{ id: 's1', billNumber: 'S 202', billTitle: 'Mail Ballots', state: 'RI', priority: 'high', isDraft: false }],
  groups: [{ key: 'h1', bills: [
    { id: 'h1', billNumber: 'H 101', state: 'RI' },
    { id: 's1', billNumber: 'S 202', state: 'RI' },
  ] }],
  date: '2999-01-01', time: '14:00:00', location: 'Senate Room 2', description: 'Senate Cmte', details: null, url: null, status: 'confirmed',
}

function show(event: CalendarEvent) {
  const value = { config: { states: ['RI'] } as AppConfig, multiState: false, loading: false }
  return render(
    <MemoryRouter>
      <ConfigContext.Provider value={value}>
        <EventPopoverContent event={event} isAdmin={false} onEdit={vi.fn()} onDelete={vi.fn()} onRestore={vi.fn()} />
      </ConfigContext.Provider>
    </MemoryRouter>,
  )
}

describe('EventPopoverContent: companion groups', () => {
  it('labels the entry by its own bill', () => {
    show(senateHearing)
    expect(screen.getAllByText(/S 202/).length).toBeGreaterThan(0)
    expect(screen.getByText('Senate Cmte')).toBeInTheDocument()
  })

  it('links to every bill in the group, the one with no hearing included', () => {
    show(senateHearing)
    const region = screen.getByRole('group', { name: 'Companion bills' })
    const links = within(region).getAllByRole('link')
    expect(links.map(l => [l.textContent, l.getAttribute('href')])).toEqual([
      ['H 101', '/bills/h1'],
      ['S 202', '/bills/s1'],
    ])
  })

  it('names each group once when the entry\'s bills belong to two', () => {
    show({
      ...senateHearing, source: 'custom', billId: null,
      bills: [
        senateHearing.bills[0],
        { id: 'k1', billNumber: 'H 601', billTitle: 'Other', state: 'RI', priority: null, isDraft: false },
      ],
      groups: [
        senateHearing.groups![0],
        { key: 'k1', bills: [{ id: 'k1', billNumber: 'H 601', state: 'RI' }, { id: 'k2', billNumber: 'S 602', state: 'RI' }] },
      ],
    })
    expect(screen.getAllByRole('group', { name: 'Companion bills' })).toHaveLength(2)
  })

  it('shows no companion links for an entry whose bills are in no group', () => {
    show({ ...senateHearing, groups: [] })
    expect(screen.queryByRole('group', { name: 'Companion bills' })).toBeNull()
  })

  it('shows none for an entry that carries no groups at all (a custom event with no bills)', () => {
    show({ ...senateHearing, source: 'custom', bills: [], groups: undefined })
    expect(screen.queryByRole('group', { name: 'Companion bills' })).toBeNull()
  })
})
