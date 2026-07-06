import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { EventPopover, EventPopoverContent, computeEventPopoverPosition } from './EventPopover'
import type { CalendarEvent } from '../../lib/calendarGrid'
import { ConfigContext, type AppConfig } from '../../context/ConfigContext'

const hearing: CalendarEvent = {
  id: '1', uid: 'a', source: 'hearing', billId: 'b1',
  bills: [{ id: 'b1', billNumber: 'H 100', billTitle: 'Title', state: 'RI', priority: 'high' }],
  date: '2999-01-01', time: null, location: 'Room', description: 'Elections Cmte', details: null, url: null, status: 'confirmed',
}
const custom: CalendarEvent = {
  ...hearing, id: '2', source: 'custom', billId: null, bills: [], description: 'Board meeting',
}

function wrap(ui: React.ReactNode, states: string[] = ['RI']) {
  const value = { config: { states } as AppConfig, multiState: states.length > 1, loading: false }
  return render(<MemoryRouter><ConfigContext.Provider value={value}>{ui}</ConfigContext.Provider></MemoryRouter>)
}

describe('EventPopover (panel)', () => {
  it('renders at the md (6px) corner radius, matching event cards', () => {
    wrap(
      <EventPopover
        event={hearing}
        isAdmin={false}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onRestore={vi.fn()}
        onClose={vi.fn()}
        position={computeEventPopoverPosition(new DOMRect(100, 100, 120, 46))}
      />,
    )
    const dlg = document.querySelector('[role="dialog"]') as HTMLElement
    expect(dlg.style.borderRadius).toBe('6px')
  })
})

describe('EventPopoverContent', () => {
  it('renders a bill chip for each bill in bills[]', () => {
    wrap(<EventPopoverContent event={hearing} isAdmin={false} onEdit={vi.fn()} onDelete={vi.fn()} onRestore={vi.fn()} />)
    expect(screen.getByText(/H 100/)).toBeInTheDocument()
  })
  it('does NOT show "All day" text', () => {
    wrap(<EventPopoverContent event={hearing} isAdmin={false} onEdit={vi.fn()} onDelete={vi.fn()} onRestore={vi.fn()} />)
    expect(screen.queryByText(/all day/i)).toBeNull()
  })
  it('does NOT show a "Go to bill" link', () => {
    wrap(<EventPopoverContent event={hearing} isAdmin={false} onEdit={vi.fn()} onDelete={vi.fn()} onRestore={vi.fn()} />)
    expect(screen.queryByRole('link', { name: /go to bill/i })).toBeNull()
  })
  it('bill chip in popover is a link to the bill', () => {
    wrap(<EventPopoverContent event={hearing} isAdmin={false} onEdit={vi.fn()} onDelete={vi.fn()} onRestore={vi.fn()} />)
    const chip = screen.getByRole('link', { name: /H 100/i })
    expect(chip).toBeInTheDocument()
    expect(chip).toHaveAttribute('href', '/bills/b1')
  })
  it('hides Edit/Delete for non-admins', () => {
    wrap(<EventPopoverContent event={custom} isAdmin={false} onEdit={vi.fn()} onDelete={vi.fn()} onRestore={vi.fn()} />)
    expect(screen.queryByRole('button', { name: /edit/i })).not.toBeInTheDocument()
  })
  it('shows Edit/Delete for admins on custom events', () => {
    wrap(<EventPopoverContent event={custom} isAdmin onEdit={vi.fn()} onDelete={vi.fn()} onRestore={vi.fn()} />)
    expect(screen.getByRole('button', { name: /edit/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /delete/i })).toBeInTheDocument()
  })
  it('does NOT show Edit/Delete for admins on hearing events', () => {
    wrap(<EventPopoverContent event={hearing} isAdmin onEdit={vi.fn()} onDelete={vi.fn()} onRestore={vi.fn()} />)
    expect(screen.queryByRole('button', { name: /edit/i })).not.toBeInTheDocument()
  })
  it('shows state prefix on BillBadge (always passes state now)', () => {
    wrap(<EventPopoverContent event={hearing} isAdmin={false} onEdit={vi.fn()} onDelete={vi.fn()} onRestore={vi.fn()} />, ['RI', 'NJ'])
    // BillBadge always receives state; BillBadge gates display internally via multiState
    expect(screen.getByText(/RI/)).toBeInTheDocument()
  })
  it('shows Restore button (not Edit/Delete) for admins on cancelled custom events', () => {
    const cancelled: CalendarEvent = { ...custom, status: 'cancelled' }
    const onRestore = vi.fn()
    wrap(<EventPopoverContent event={cancelled} isAdmin onEdit={vi.fn()} onDelete={vi.fn()} onRestore={onRestore} />)
    expect(screen.queryByRole('button', { name: /edit/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /delete/i })).not.toBeInTheDocument()
    const restoreBtn = screen.getByRole('button', { name: /restore/i })
    expect(restoreBtn).toBeInTheDocument()
    fireEvent.click(restoreBtn)
    expect(onRestore).toHaveBeenCalledWith(cancelled)
  })
})

describe('EventPopoverContent expanded variant', () => {
  it('still renders bill chips, location, and actions', () => {
    wrap(<EventPopoverContent expanded event={custom} isAdmin onEdit={vi.fn()} onDelete={vi.fn()} onRestore={vi.fn()} />)
    expect(screen.getByRole('button', { name: /edit/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /delete/i })).toBeInTheDocument()
  })

  it('renders the date BEFORE the event body (top line), like the covering popover', () => {
    const { container } = wrap(
      <EventPopoverContent expanded event={hearing} isAdmin={false} onEdit={vi.fn()} onDelete={vi.fn()} onRestore={vi.fn()} />,
    )
    const root = container.querySelector('[data-event-detail]') as HTMLElement
    const text = root.textContent ?? ''
    const bodyIdx = text.indexOf('Elections Cmte')
    const dateIdx = text.search(/Jan/i) // eventDateLabel formats month; date is now at the top
    expect(dateIdx).toBeGreaterThanOrEqual(0)
    expect(dateIdx).toBeLessThan(bodyIdx)
  })

  it('non-expanded variant still renders the date at the top (regression)', () => {
    const { container } = wrap(
      <EventPopoverContent event={hearing} isAdmin={false} onEdit={vi.fn()} onDelete={vi.fn()} onRestore={vi.fn()} />,
    )
    const root = container.querySelector('[data-event-detail]') as HTMLElement
    const text = root.textContent ?? ''
    const bodyIdx = text.indexOf('Elections Cmte')
    const dateIdx = text.search(/Jan/i)
    expect(dateIdx).toBeLessThan(bodyIdx) // date before body
  })
})

function rectOf(top: number, bottom: number, left: number, right: number = left): DOMRect {
  return { x: left, y: top, top, bottom, left, right, width: right - left, height: bottom - top, toJSON() { return {} } } as DOMRect
}

describe('computeEventPopoverPosition', () => {
  it('drops down when there is room below', () => {
    const p = computeEventPopoverPosition(rectOf(100, 120, 50), {}, 1200, 800)
    expect(p.transformOrigin).toBe('top left')
    expect(p.enterOffsetY).toBe(-6)
    expect(p.positionStyle.top).toBe(126)
    expect(p.positionStyle.bottom).toBeUndefined()
    expect(p.positionStyle.left).toBe(50)
  })
  it('pops up when the event is low in the viewport', () => {
    const p = computeEventPopoverPosition(rectOf(740, 760, 50), {}, 1200, 800)
    expect(p.transformOrigin).toBe('bottom left')
    expect(p.enterOffsetY).toBe(6)
    expect(p.positionStyle.bottom).toBe(66) // 800 - 740 + 6
    expect(p.positionStyle.top).toBeUndefined()
  })
  it('clamps left so the panel does not overflow the right edge', () => {
    const p = computeEventPopoverPosition(rectOf(100, 120, 1150), {}, 1200, 800)
    expect(p.positionStyle.left).toBe(892) // 1200 - 300 - 8
  })
  it('uses the passed width for the right-edge clamp', () => {
    const p = computeEventPopoverPosition(rectOf(100, 120, 1150), { width: 320 }, 1200, 800)
    expect(p.positionStyle.left).toBe(872) // 1200 - 320 - 8
    expect(p.positionStyle.width).toBe(320)
  })
  it('right-aligns the panel to the trigger and springs down-left', () => {
    // trigger at left=900..right=1000, width 260 → left = 1000 - 260 = 740
    const p = computeEventPopoverPosition(rectOf(100, 120, 900, 1000), { width: 260, align: 'right' }, 1200, 800)
    expect(p.positionStyle.left).toBe(740)
    expect(p.transformOrigin).toBe('top right')
  })
  it('grow mode drops maxHeight/overflow so children can flow past the panel', () => {
    const p = computeEventPopoverPosition(rectOf(100, 120, 50), { grow: true }, 1200, 800)
    expect(p.positionStyle.maxHeight).toBeUndefined()
    expect(p.positionStyle.overflow).toBeUndefined()
  })
})
