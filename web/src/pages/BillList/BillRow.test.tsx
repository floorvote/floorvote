import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, fireEvent, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { BillRow } from './BillRow'
import type { Bill } from './types'

// BillRow reads org copy off ConfigContext; the actual config shape doesn't
// matter for this test, so stub it out rather than standing up a real provider.
vi.mock('../../context/ConfigContext', () => ({
  useConfig: () => ({ config: null, multiState: false, loading: false }),
  useMultiState: () => false,
}))

// Mutable flag so individual tests can opt into demoLocked without a
// module-level mock rewrite per test (mirrors Members.roleRename.test.tsx).
const demoState = vi.hoisted(() => ({ demoLocked: false }))
vi.mock('../../context/DemoContext', () => ({
  useDemo: () => ({ demoMode: false, demoLocked: demoState.demoLocked }),
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

function renderRow(isAdmin: boolean, opts: { onVote?: (billId: string, pos: 'support' | 'neutral' | 'oppose') => void; bill?: Partial<Bill> } = {}) {
  return render(
    <MemoryRouter>
      <BillRow
        bill={makeBill(opts.bill)}
        index={0}
        selectedTags={[]}
        onTagClick={vi.fn()}
        isAdmin={isAdmin}
        positionVocabulary={['Support', 'Oppose']}
        onStatusClick={vi.fn()}
        onPriorityClick={vi.fn()}
        onPositionClick={vi.fn()}
        onRelevanceClick={vi.fn()}
        onPriorityChange={vi.fn()}
        onPositionChange={vi.fn()}
        onVote={opts.onVote}
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

describe('BillRow write controls when demoLocked', () => {
  afterEach(() => { demoState.demoLocked = false })

  it('leaves the admin Position select enabled — the server allows it', () => {
    demoState.demoLocked = true
    renderRow(true)
    expect(screen.getByRole('combobox', { name: /position/i })).toBeEnabled()
  })

  it('leaves the admin Priority select enabled — the server allows it', () => {
    demoState.demoLocked = true
    renderRow(true)
    // Priority renders twice — a desktop column and a mobile-meta duplicate,
    // toggled between by CSS, both present in the DOM at once.
    const selects = screen.getAllByRole('combobox', { name: /priority/i })
    expect(selects.length).toBeGreaterThan(0)
    for (const select of selects) expect(select).toBeEnabled()
  })

  it('leaves the member-vote bars enabled and calls onVote when clicked', () => {
    demoState.demoLocked = true
    const onVote = vi.fn()
    renderRow(false, { onVote })
    const supportBtn = screen.getByRole('button', { name: 'Support' })
    expect(supportBtn).toBeEnabled()
    fireEvent.click(supportBtn)
    expect(onVote).toHaveBeenCalled()
  })
})

// The row sets position:relative with a z-index, which makes it a stacking
// context: every z-index inside it is ordered only against its siblings, so no
// inner value — however large — can compete with the sticky filter/column
// header outside it. The vote tooltip previously asked for z-index 200 from
// inside that trap and was painted behind the header anyway. Escaping to
// document.body is what actually fixes it, so that is what these pin.
describe('BillRow tooltips escape the row stacking context', () => {
  afterEach(() => { demoState.demoLocked = false })

  it('renders the vote-button tooltip outside the row subtree', () => {
    const { container } = renderRow(false, { onVote: vi.fn() })
    fireEvent.pointerEnter(screen.getByRole('button', { name: 'Support' }), { pointerType: 'mouse' })
    const bubble = screen.getByText(/vote support on this bill/i)
    expect(bubble).toBeInTheDocument()
    expect(container.contains(bubble)).toBe(false)
  })

  // Scope to the desktop column rather than taking the first matching combobox:
  // each control also renders a mobile-meta duplicate, and the two are wrapped
  // differently, so an index-based lookup silently targets the wrong one.
  it('renders the position-select tooltip outside the row subtree', () => {
    const { container } = renderRow(true)
    // Walk up from the control, not down from the column: the column's first
    // span is its "Position" label, not the tooltip wrapper.
    const wrapper = container.querySelector('.bill-col-position select')!.closest('span')!
    fireEvent.pointerEnter(wrapper, { pointerType: 'mouse' })
    expect(container.contains(screen.getByText(/official position on this bill/i))).toBe(false)
  })

  it('renders the priority-select tooltip outside the row subtree', () => {
    const { container } = renderRow(true)
    const wrapper = container.querySelector('.bill-col-priority span')!
    fireEvent.pointerEnter(wrapper, { pointerType: 'mouse' })
    expect(container.contains(screen.getByText(/priority level/i))).toBe(false)
  })
})
