import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { BillRow } from './BillRow'
import type { Bill } from './types'

// BillRow reads org copy off ConfigContext; the actual config shape doesn't
// matter for this test, so stub it out rather than standing up a real provider.
vi.mock('../../context/ConfigContext', () => ({
  useConfig: () => ({ config: null, multiState: false, loading: false }),
  useMultiState: () => false,
}))

function makeBill(over: Partial<Bill> = {}): Bill {
  return {
    id: 'b1', billNumber: 'HB 1', title: 'Test bill', state: 'RI', status: '2',
    session: '2025-2026', sessionId: null, yearStart: 2025, yearEnd: 2026,
    abstract: null, url: null, stateUrl: null, lastAction: null,
    lastActionDate: '2026-02-01', tenantSummary: null, tags: [], priority: null,
    matchType: null, isDraft: false, position: null, relevanceScore: null,
    aiProcessedAt: null, newMatchAt: null, triagedAt: null,
    voteCounts: { support: 0, oppose: 0, neutral: 0 }, myVote: null,
    commentCount: 0, hasNote: false, hasComment: false, updatedAt: '2026-02-01 10:00:00',
    customFieldValues: {},
    ...over,
  }
}

function renderRow(isAdmin: boolean) {
  return render(
    <MemoryRouter>
      <BillRow
        bill={makeBill()}
        index={0}
        selectedTags={[]}
        onTagClick={vi.fn()}
        isAdmin={isAdmin}
        positionVocabulary={[]}
        onStatusClick={vi.fn()}
        onPriorityClick={vi.fn()}
        onPositionClick={vi.fn()}
        onRelevanceClick={vi.fn()}
        onPriorityChange={vi.fn()}
        onPositionChange={vi.fn()}
        onVote={undefined}
        filterStatuses={[]}
        filterPriorities={[]}
        filterPositions={[]}
        filterYears={[]}
        filterMinRelevance={0}
        sortedPaths={[]}
        isMultiState={false}
        isSelectionMode={false}
        isSelected={false}
        onToggleSelect={isAdmin ? vi.fn() : undefined}
      />
    </MemoryRouter>,
  )
}

describe('BillRow hover selection checkbox', () => {
  it('does not render a checkbox on hover for non-admins', () => {
    const { container } = renderRow(false)
    const row = container.querySelector('.bill-row-grid') as HTMLElement
    fireEvent.mouseEnter(row)
    expect(container.querySelector('input[type="checkbox"]')).toBeNull()
  })

  it('renders a checkbox on hover for admins', () => {
    const { container } = renderRow(true)
    const row = container.querySelector('.bill-row-grid') as HTMLElement
    fireEvent.mouseEnter(row)
    expect(container.querySelector('input[type="checkbox"]')).not.toBeNull()
  })
})
