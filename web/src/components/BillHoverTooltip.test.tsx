import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

const fetchMock = vi.fn()
vi.mock('../lib/api', () => ({ apiFetch: (...a: unknown[]) => fetchMock(...a) }))

import { BillHoverTooltip, useBillTooltip } from './BillHoverTooltip'

function Harness() {
  const { onEnter, onMove, onLeave, tooltip } = useBillTooltip()
  const bill = { billNumber: 'H 100', title: 'A bill about elections', summary: 'Does things', priority: 'high' as const }
  return (
    <div>
      <span
        data-testid="chip"
        onMouseEnter={(e) => onEnter(bill, e)}
        onMouseMove={(e) => onMove(bill, e)}
        onMouseLeave={onLeave}
      >H 100</span>
      {tooltip}
    </div>
  )
}

beforeEach(() => { fetchMock.mockReset() })

describe('BillHoverTooltip lazy summary', () => {
  it('fetches the summary by billId when none is passed', async () => {
    fetchMock.mockResolvedValue({ tenantSummary: 'A lazy summary.' })
    render(<BillHoverTooltip bill={{ billNumber: 'H 1', billId: 'b1', title: 'T', summary: null, priority: null }} cursor={{ x: 0, y: 0 }} />)
    await waitFor(() => expect(screen.getByText('A lazy summary.')).toBeInTheDocument())
    expect(fetchMock).toHaveBeenCalledWith('/bills/b1')
  })
  it('does not fetch when a summary is already provided', () => {
    render(<BillHoverTooltip bill={{ billNumber: 'H 1', billId: 'b2', title: 'T', summary: 'Eager.', priority: null }} cursor={{ x: 0, y: 0 }} />)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(screen.getByText('Eager.')).toBeInTheDocument()
  })
})

describe('useBillTooltip', () => {
  it('shows the tooltip on hover and hides on leave', () => {
    render(<Harness />)
    expect(screen.queryByText('A bill about elections')).toBeNull()
    fireEvent.mouseEnter(screen.getByTestId('chip'), { clientX: 10, clientY: 10 })
    expect(screen.getByText('A bill about elections')).toBeInTheDocument()
    fireEvent.mouseLeave(screen.getByTestId('chip'))
    expect(screen.queryByText('A bill about elections')).toBeNull()
  })
})

describe('BillHoverTooltip untitled drafts', () => {
  it('shows "Untitled draft" for a draft with a blank title', () => {
    render(<BillHoverTooltip bill={{ billNumber: 'D1', title: '', isDraft: true, summary: 'S.', priority: null }} cursor={{ x: 0, y: 0 }} />)
    expect(screen.getByText('Untitled draft')).toBeInTheDocument()
  })
  it("shows a titled draft's own title", () => {
    render(<BillHoverTooltip bill={{ billNumber: 'D1', title: 'Draft bill title', isDraft: true, summary: 'S.', priority: null }} cursor={{ x: 0, y: 0 }} />)
    expect(screen.getByText('Draft bill title')).toBeInTheDocument()
    expect(screen.queryByText('Untitled draft')).toBeNull()
  })
  it('never labels a filed bill "Untitled draft"', () => {
    render(<BillHoverTooltip bill={{ billNumber: 'H 1', title: '', summary: 'S.', priority: null }} cursor={{ x: 0, y: 0 }} />)
    expect(screen.queryByText('Untitled draft')).toBeNull()
  })
})

describe('BillHoverTooltip placement', () => {
  const BILL = { billNumber: 'H 1', title: 'Placement title', summary: null, priority: null }
  function withSize(w: number, h: number, innerHeight = 800) {
    const ow = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(w)
    const oh = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(h)
    const ih = Object.getOwnPropertyDescriptor(window, 'innerHeight')
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: innerHeight })
    return () => { ow.mockRestore(); oh.mockRestore(); if (ih) Object.defineProperty(window, 'innerHeight', ih) }
  }
  const bubbleEl = () => screen.getByText('Placement title').closest('div[style*="position: fixed"]') as HTMLElement

  it('opens above the pointer, its bottom edge just over the cursor', () => {
    const restore = withSize(200, 100)
    try {
      render(<BillHoverTooltip bill={BILL} cursor={{ x: 300, y: 400 }} />)
      expect(parseFloat(bubbleEl().style.top)).toBe(400 - 18 - 100)
      expect(parseFloat(bubbleEl().style.left)).toBe(316)
    } finally { restore() }
  })

  it('flips below the pointer only when there is no room above it', () => {
    const restore = withSize(200, 100)
    try {
      render(<BillHoverTooltip bill={BILL} cursor={{ x: 300, y: 50 }} />)
      expect(parseFloat(bubbleEl().style.top)).toBe(50 + 18)
    } finally { restore() }
  })

  it('stays above when it just fits', () => {
    const restore = withSize(200, 100)
    try {
      render(<BillHoverTooltip bill={BILL} cursor={{ x: 300, y: 126 }} />)
      expect(parseFloat(bubbleEl().style.top)).toBe(8)
    } finally { restore() }
  })

  it('keeps a flipped bubble on screen at the bottom edge', () => {
    const restore = withSize(200, 100, 120)
    try {
      render(<BillHoverTooltip bill={BILL} cursor={{ x: 300, y: 60 }} />)
      expect(parseFloat(bubbleEl().style.top)).toBeLessThanOrEqual(120 - 100 - 8 + 0.01)
    } finally { restore() }
  })

  it('moves up again when the lazy summary loads and the bubble grows, so it never covers the pointer', async () => {
    const oh = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.textContent?.includes('Loaded summary text') ? 180 : 100
    })
    const ow = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(200)
    try {
      fetchMock.mockResolvedValue({ tenantSummary: 'Loaded summary text' })
      render(<BillHoverTooltip bill={{ billNumber: 'H 9', billId: 'grow-1', title: 'Placement title', summary: null, priority: null }} cursor={{ x: 300, y: 400 }} />)
      expect(parseFloat(bubbleEl().style.top)).toBe(400 - 18 - 100)
      await waitFor(() => expect(screen.getByText('Loaded summary text')).toBeInTheDocument())
      await waitFor(() => expect(parseFloat(bubbleEl().style.top)).toBe(400 - 18 - 180))
    } finally { oh.mockRestore(); ow.mockRestore() }
  })
})
