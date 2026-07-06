import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { DayPopover, computeDayPopoverPosition } from './DayPopover'
import type { CalendarEvent } from '../../lib/calendarGrid'

vi.mock('../../lib/calendarGrid', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/calendarGrid')>()
  return { ...actual, todayIso: () => '2099-01-01' }
})

const VW = 1024
const VH = 768
const W = 300

function rect(left: number, top: number, w = 150, h = 158): DOMRect {
  return new DOMRect(left, top, w, h)
}

describe('computeDayPopoverPosition', () => {
  it('shares the top edge of the day cell so the panel covers it', () => {
    const pos = computeDayPopoverPosition(rect(100, 200), { width: W }, VW, VH)
    expect((pos.positionStyle as { top: number }).top).toBe(200)
  })

  it('left-aligns and springs from the top-left corner for early columns', () => {
    const pos = computeDayPopoverPosition(rect(100, 200), { width: W }, VW, VH)
    expect((pos.positionStyle as { left: number }).left).toBe(100)
    expect(pos.transformOrigin).toBe('top left')
  })

  it('forces a top-right origin when alignRight is set, even if a left panel would fit', () => {
    // A cell where a left-aligned panel WOULD fit (500 + 300 < 1024), but the
    // Fri/Sat alignRight flag forces a right-corner origin anyway.
    const cellLeft = 500
    const pos = computeDayPopoverPosition(rect(cellLeft, 200), { width: W, alignRight: true }, VW, VH)
    expect(pos.transformOrigin).toBe('top right')
    expect((pos.positionStyle as { left: number }).left).toBe(cellLeft + 150 - W) // 350
  })

  it('flips to the top-right corner when a left-aligned panel would overflow the viewport', () => {
    // A Friday/Saturday cell near the right edge: left + width would exceed VW.
    const cellLeft = 880 // 880 + 300 = 1180 > 1024 - 8
    const pos = computeDayPopoverPosition(rect(cellLeft, 200), { width: W }, VW, VH)
    // right edge of the panel aligns to the cell's right edge (cellLeft + 150)
    expect((pos.positionStyle as { left: number }).left).toBe(cellLeft + 150 - W)
    expect(pos.transformOrigin).toBe('top right')
  })

  it('keeps a bottom-row cell on screen by lifting the panel up to fit', () => {
    const pos = computeDayPopoverPosition(rect(100, 700), { width: W }, VW, VH)
    const { top, maxHeight } = pos.positionStyle as { top: number; maxHeight: number }
    // The panel (top + height) must stay within the viewport.
    expect(top + maxHeight).toBeLessThanOrEqual(VH)
    expect(maxHeight).toBeGreaterThan(0)
    // It was lifted above the cell's original top (700) to make room.
    expect(top).toBeLessThan(700)
  })
})

const dayEvents: CalendarEvent[] = [
  { id: '1', uid: 'a', source: 'hearing', billId: 'b1', bills: [{ id: 'b1', billNumber: 'H 100', billTitle: 'Elections bill', state: 'RI', priority: 'high' }], date: '2026-06-15', time: '09:00', location: 'Room 313', description: null, details: null, url: null, status: 'confirmed' },
  { id: '2', uid: 'b', source: 'custom', billId: null, bills: [], date: '2026-06-15', time: null, location: null, description: 'Board meeting', details: null, url: null, status: 'confirmed' },
  { id: '3', uid: 'c', source: 'hearing', billId: 'b2', bills: [{ id: 'b2', billNumber: 'S 47', billTitle: 'Ethics', state: 'RI', priority: 'low' }], date: '2026-06-15', time: '14:00', location: null, description: null, details: null, url: null, status: 'confirmed' },
]

const noop = () => {}

describe('DayPopover', () => {
  it('lists every event for the day (including ones hidden behind "+N more")', () => {
    render(
      <MemoryRouter>
        <DayPopover
          dateIso="2026-06-15"
          events={dayEvents}
          isAdmin={false}
          position={computeDayPopoverPosition(rect(100, 200), { width: W }, VW, VH)}
          onClose={noop}
          onEdit={noop}
          onDelete={noop}
          onRestore={noop}
        />
      </MemoryRouter>,
    )
    expect(screen.getByText('H 100')).toBeInTheDocument()
    expect(screen.getByText('Board meeting')).toBeInTheDocument()
    expect(screen.getByText('S 47')).toBeInTheDocument()
  })

  it('renders at the md (6px) corner radius, matching event cards', () => {
    render(
      <MemoryRouter>
        <DayPopover
          dateIso="2026-06-15"
          events={dayEvents}
          isAdmin={false}
          position={computeDayPopoverPosition(rect(100, 200), { width: W }, VW, VH)}
          onClose={noop}
          onEdit={noop}
          onDelete={noop}
          onRestore={noop}
        />
      </MemoryRouter>,
    )
    const dlg = document.querySelector('[role="dialog"]') as HTMLElement
    expect(dlg.style.borderRadius).toBe('6px')
  })

  it('shows a date header for the day', () => {
    render(
      <MemoryRouter>
        <DayPopover
          dateIso="2026-06-15"
          events={dayEvents}
          isAdmin={false}
          position={computeDayPopoverPosition(rect(100, 200), { width: W }, VW, VH)}
          onClose={noop}
          onEdit={noop}
          onDelete={noop}
          onRestore={noop}
        />
      </MemoryRouter>,
    )
    // June 15 2026 is a Monday
    expect(screen.getByText(/Mon/)).toBeInTheDocument()
    expect(screen.getByText(/Jun 15/)).toBeInTheDocument()
  })

  it('offers Edit/Delete on custom events for admins', () => {
    render(
      <MemoryRouter>
        <DayPopover
          dateIso="2026-06-15"
          events={dayEvents}
          isAdmin
          position={computeDayPopoverPosition(rect(100, 200), { width: W }, VW, VH)}
          onClose={noop}
          onEdit={vi.fn()}
          onDelete={vi.fn()}
          onRestore={vi.fn()}
        />
      </MemoryRouter>,
    )
    expect(screen.getByRole('button', { name: 'Edit event' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Delete event' })).toBeInTheDocument()
  })
})
