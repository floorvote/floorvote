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
