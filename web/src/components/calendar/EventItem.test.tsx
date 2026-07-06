import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { EventItem } from './EventItem'
import type { CalendarEvent } from '../../lib/calendarGrid'
import { color } from '../../styles/tokens'

const hearing: CalendarEvent = {
  id: '1', uid: 'a', source: 'hearing', billId: 'b1',
  bills: [{ id: 'b1', billNumber: 'H 100', billTitle: 'Title', state: 'RI', priority: 'high' }],
  date: '2999-01-01', time: '09:00', location: 'Room 1', description: 'Elections Cmte', details: null, url: null, status: 'confirmed',
}
const allDayCustom: CalendarEvent = {
  id: '2', uid: 'b', source: 'custom', billId: null, bills: [],
  date: '2999-01-02', time: null, location: null, description: 'Board meeting', details: null, url: null, status: 'confirmed',
}
const customConfirmed: CalendarEvent = {
  id: '3', uid: 'c', source: 'custom', billId: null, bills: [],
  date: '2999-01-03', time: '10:00', location: null, description: 'Policy meeting', details: null, url: null, status: 'confirmed',
}
const customCancelled: CalendarEvent = {
  id: '4', uid: 'd', source: 'custom', billId: null, bills: [],
  date: '2999-01-04', time: '14:00', location: null, description: 'Cancelled session', details: null, url: null, status: 'cancelled',
}
const customWithBill: CalendarEvent = {
  id: '5', uid: 'e', source: 'custom', billId: null,
  bills: [{ id: 'b9', billNumber: 'S 9', billTitle: 'Linked bill', state: 'RI', priority: 'low' }],
  date: '2999-01-05', time: '12:00', location: null, description: 'Linked custom event', details: null, url: null, status: 'confirmed',
}

function renderItem(event: CalendarEvent, isAdmin: boolean, props?: Partial<Parameters<typeof EventItem>[0]>) {
  const onEdit = vi.fn()
  const onDelete = vi.fn()
  const onRestore = vi.fn()
  const onEditSave = vi.fn()
  const onEditCancel = vi.fn()
  render(
    <MemoryRouter>
      <EventItem
        event={event}
        isPast={false}
        isAdmin={isAdmin}
        editing={false}
        billOptions={[]}
        onEdit={onEdit}
        onEditSave={onEditSave}
        onEditCancel={onEditCancel}
        onDelete={onDelete}
        onRestore={onRestore}
        {...props}
      />
    </MemoryRouter>
  )
  return { onEdit, onDelete, onRestore, onEditSave, onEditCancel }
}

describe('EventItem', () => {
  it('renders the event name with bill chips below (no All day label)', () => {
    render(<MemoryRouter><EventItem event={hearing} isPast={false} isAdmin={false} editing={false} billOptions={[]} onEdit={vi.fn()} onEditSave={vi.fn()} onEditCancel={vi.fn()} onDelete={vi.fn()} onRestore={vi.fn()} /></MemoryRouter>)
    expect(screen.getByText('Elections Cmte')).toBeInTheDocument()
    expect(screen.getByText(/H 100/)).toBeInTheDocument()
  })
  it('omits the All day label for time-less events', () => {
    render(<MemoryRouter><EventItem event={allDayCustom} isPast={false} isAdmin={false} editing={false} billOptions={[]} onEdit={vi.fn()} onEditSave={vi.fn()} onEditCancel={vi.fn()} onDelete={vi.fn()} onRestore={vi.fn()} /></MemoryRouter>)
    expect(screen.queryByText(/all day/i)).toBeNull()
  })

  describe('source icon', () => {
    // jsdom serializes inline hex colors as rgb(...), so compare on that form.
    const hexToRgb = (hex: string) => {
      const n = parseInt(hex.slice(1), 16)
      return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`
    }

    it('custom events always get the blue calendar tile, even when linked to a bill', () => {
      const { container } = render(<MemoryRouter><EventItem event={customWithBill} isPast={false} isAdmin={false} editing={false} billOptions={[]} onEdit={vi.fn()} onEditSave={vi.fn()} onEditCancel={vi.fn()} onDelete={vi.fn()} onRestore={vi.fn()} /></MemoryRouter>)
      const card = container.querySelector('#agenda-event-5') as HTMLElement
      const tile = card.querySelector('[role="img"]') as HTMLElement
      expect(tile.getAttribute('aria-label')).toBe('Custom event')
      expect(tile.textContent).toBe('calendar_today')
      expect(tile.style.color).toBe(hexToRgb(color.accentBlue))
      // Exactly one source icon should appear on the agenda card (tile from EventSourceIcon,
      // no duplicate inline glyph from EventLines).
      expect(card.querySelectorAll('[role="img"]').length).toBe(1)
    })

    it('hearing events get the navy gavel tile', () => {
      const { container } = render(<MemoryRouter><EventItem event={hearing} isPast={false} isAdmin={false} editing={false} billOptions={[]} onEdit={vi.fn()} onEditSave={vi.fn()} onEditCancel={vi.fn()} onDelete={vi.fn()} onRestore={vi.fn()} /></MemoryRouter>)
      const card = container.querySelector('#agenda-event-1') as HTMLElement
      const tile = card.querySelector('[role="img"]') as HTMLElement
      expect(tile.getAttribute('aria-label')).toBe('Hearing')
      expect(tile.textContent).toBe('gavel')
      expect(tile.style.color).toBe(hexToRgb(color.billBadgeNavy))
      // Exactly one source icon should appear on the agenda card (tile from EventSourceIcon,
      // no duplicate inline glyph from EventLines).
      expect(card.querySelectorAll('[role="img"]').length).toBe(1)
    })
  })

  describe('admin controls visibility', () => {
    it('custom confirmed + isAdmin=true → shows Edit and Delete, no Restore', () => {
      renderItem(customConfirmed, true)
      expect(screen.getByRole('button', { name: /edit/i })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /delete/i })).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /restore/i })).toBeNull()
    })

    it('custom cancelled + isAdmin=true → shows Restore, no Edit or Delete', () => {
      renderItem(customCancelled, true)
      expect(screen.getByRole('button', { name: /restore/i })).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /edit/i })).toBeNull()
      expect(screen.queryByRole('button', { name: /delete/i })).toBeNull()
    })

    it('custom + isAdmin=false → shows no admin buttons', () => {
      renderItem(customConfirmed, false)
      expect(screen.queryByRole('button', { name: /edit/i })).toBeNull()
      expect(screen.queryByRole('button', { name: /delete/i })).toBeNull()
      expect(screen.queryByRole('button', { name: /restore/i })).toBeNull()
    })

    it('hearing + isAdmin=true → shows no admin buttons', () => {
      renderItem(hearing, true)
      expect(screen.queryByRole('button', { name: /edit/i })).toBeNull()
      expect(screen.queryByRole('button', { name: /delete/i })).toBeNull()
      expect(screen.queryByRole('button', { name: /restore/i })).toBeNull()
    })

    it('clicking Edit calls onEdit with the event', () => {
      const { onEdit } = renderItem(customConfirmed, true)
      fireEvent.click(screen.getByRole('button', { name: /edit/i }))
      expect(onEdit).toHaveBeenCalledOnce()
      expect(onEdit).toHaveBeenCalledWith(customConfirmed)
    })
  })

  describe('inline editing', () => {
    it('when editing=true, renders a Title input and Save button instead of static title', () => {
      render(
        <MemoryRouter>
          <EventItem
            event={customConfirmed}
            isPast={false}
            isAdmin={true}
            editing={true}
            billOptions={[]}
            onEdit={vi.fn()}
            onEditSave={vi.fn()}
            onEditCancel={vi.fn()}
            onDelete={vi.fn()}
            onRestore={vi.fn()}
          />
        </MemoryRouter>
      )
      expect(screen.getByRole('textbox', { name: /title/i })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /save/i })).toBeInTheDocument()
      // Static title text should not be visible as a standalone element
      expect(screen.queryByText('Policy meeting')).not.toBeInTheDocument()
    })

    it('when editing=true, Cancel button calls onEditCancel', () => {
      const onEditCancel = vi.fn()
      render(
        <MemoryRouter>
          <EventItem
            event={customConfirmed}
            isPast={false}
            isAdmin={true}
            editing={true}
            billOptions={[]}
            onEdit={vi.fn()}
            onEditSave={vi.fn()}
            onEditCancel={onEditCancel}
            onDelete={vi.fn()}
            onRestore={vi.fn()}
          />
        </MemoryRouter>
      )
      fireEvent.click(screen.getByRole('button', { name: /cancel/i }))
      expect(onEditCancel).toHaveBeenCalledOnce()
    })

    it('when editing=false, does not render a Title input', () => {
      renderItem(customConfirmed, true)
      expect(screen.queryByRole('textbox', { name: /title/i })).toBeNull()
    })
  })
})
