import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, fireEvent, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { BillRow } from './BillRow'
import type { Bill } from './types'

const navigateMock = vi.hoisted(() => vi.fn())
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom')
  return { ...actual, useNavigate: () => navigateMock }
})

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
    session: '2025-2026', sessionSlug: '2025-2026', sessionId: null, yearStart: 2025, yearEnd: 2026,
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

describe('BillRow row-click navigation target', () => {
  afterEach(() => { navigateMock.mockClear() })

  it('links a filed bill to its canonical /STATE/SESSION/BILL path', () => {
    const { container } = renderRow(false, { bill: { state: 'RI', sessionSlug: '2025-2026', billNumber: 'HB 1' } })
    fireEvent.click(container.querySelector('.bill-row-grid') as HTMLElement)
    expect(navigateMock).toHaveBeenCalledWith('/RI/2025-2026/HB 1', expect.anything())
  })

  it('links a draft with a state to /STATE/YEAR/D-number, not /bills/:id', () => {
    const { container } = renderRow(false, {
      bill: { id: 'draft-1', isDraft: true, state: 'IL', session: '', sessionSlug: '2026', billNumber: 'D1' },
    })
    fireEvent.click(container.querySelector('.bill-row-grid') as HTMLElement)
    expect(navigateMock).toHaveBeenCalledWith('/IL/2026/D1', expect.anything())
  })

  it('links a stateless draft to /bills/:id', () => {
    const { container } = renderRow(false, {
      bill: { id: 'draft-2', isDraft: true, state: '', session: '', sessionSlug: '2026', billNumber: 'D1' },
    })
    fireEvent.click(container.querySelector('.bill-row-grid') as HTMLElement)
    expect(navigateMock).toHaveBeenCalledWith('/bills/draft-2', expect.anything())
  })
})

describe('BillRow draft visual marker', () => {
  it('renders a dashed badge and the Draft chip for a draft bill', () => {
    const { container } = renderRow(false, {
      bill: { id: 'draft-1', isDraft: true, state: 'IL', status: '', sessionSlug: '2026', billNumber: 'D1' },
    })
    // Desktop badge — dashed border, transparent fill (the "not filed yet" signal).
    const badges = screen.getAllByText('D1', { exact: false })
    expect(badges.length).toBeGreaterThan(0)
    const badge = badges[0].closest('a, span') as HTMLElement
    expect(badge.style.border).toContain('dashed')
    expect(badge.style.background === '' || badge.style.background === 'transparent').toBe(true)

    // The word "Draft" appears (in the status cell / mobile meta row), and the
    // old solid gray chip is gone — replaced by a dashed, inert marker.
    const draftChips = screen.getAllByText('Draft')
    expect(draftChips.length).toBeGreaterThan(0)
    for (const chip of draftChips) {
      expect(chip.tagName).not.toBe('BUTTON')
      expect(chip.style.border).toContain('dashed')
    }
    expect(container.querySelector('button')?.textContent).not.toBe('Draft')
  })

  it('renders neither a dashed badge nor the Draft chip for a filed bill', () => {
    renderRow(false, { bill: { id: 'b1', isDraft: false, state: 'RI', status: '2', billNumber: 'HB 1' } })
    expect(screen.queryByText('Draft')).not.toBeInTheDocument()
    const badge = screen.getAllByText('HB 1', { exact: false })[0].closest('a, span') as HTMLElement
    expect(badge.style.border).not.toContain('dashed')
  })
})

// /bills is virtualized with TanStack Virtual, and row heights are measured
// once at mount and never re-measured (a separately recorded, out-of-scope
// bug: the ResizeObserver path never attaches). A marker that changes a row's
// rendered height is exactly the shape of change that produces stale
// heights — gaps or overlap between rows. These tests check the title-line
// Draft marker (the mid-width fallback shown when the Status column is
// hidden — see mobile.css .bill-title-draft-marker) against that constraint.
describe('BillRow title-line Draft marker does not change row height', () => {
  // The marker must fit inside the title's own line box. If it doesn't, every
  // draft row in the mid-width band is taller than it was at mount — and /bills
  // is virtualized with row heights measured once at mount and never
  // re-measured (a separately recorded, out-of-scope bug: the ResizeObserver
  // path never attaches), so the list renders gaps or overlapping rows.
  //
  // jsdom runs no layout, so offsetHeight/getBoundingClientRect are all zero
  // here and any assertion built on them passes for every mutation. (An
  // earlier version of this block compared two title divs' offsetHeight and
  // was vacuous; it was deleted rather than left looking like coverage.)
  // What jsdom *does* give us is the two elements' declared boxes, which come
  // from two independent places in the source: the marker's own style
  // (DraftChip.tsx) and the title div's style (BillRow.tsx). Reading both off
  // the rendered DOM and comparing them is a real constraint — it fails if
  // either side drifts.
  it("the marker's own box fits inside the title's line box, both read from the DOM", () => {
    const { container } = renderRow(false, {
      bill: { id: 'draft-1', isDraft: true, status: '', billNumber: 'D1', title: 'Voter Identification Requirements' },
    })
    const marker = screen.getByText('Draft', { selector: '.bill-title-draft-marker' })
    const title = marker.parentElement as HTMLElement
    expect(title).toBeTruthy()
    expect(title.textContent).toContain('Voter Identification Requirements')
    expect(container.contains(title)).toBe(true)

    // Title line box: read the title div's real declared values, not constants
    // restated here. lineHeight is unitless on the title, so it multiplies its
    // own font-size.
    const titleFontSize = parseFloat(title.style.fontSize)
    const titleLineHeightRatio = parseFloat(title.style.lineHeight)
    expect(titleFontSize).toBeGreaterThan(0)
    expect(titleLineHeightRatio).toBeGreaterThan(0)
    expect(title.style.lineHeight).not.toMatch(/px|em|%/) // unitless multiplier
    const titleLineBox = titleFontSize * titleLineHeightRatio

    // Marker box: line-height + vertical padding + vertical border.
    const s = marker.style
    const markerLineHeight = parseFloat(s.lineHeight)
    expect(s.lineHeight).toMatch(/px$/) // explicit px, so this sum is meaningful
    const paddingV = (parseFloat(s.paddingTop) || 0) + (parseFloat(s.paddingBottom) || 0)
    const borderMatch = /^(\d+(?:\.\d+)?)px/.exec(s.border || s.borderTopWidth || '')
    expect(borderMatch).not.toBeNull()
    const borderV = parseFloat(borderMatch![1]) * 2
    const markerBox = markerLineHeight + paddingV + borderV

    expect(markerBox).toBeLessThanOrEqual(titleLineBox)
  })

  // A box that fits is only half of it: the marker must also sit *on* the
  // line rather than beside or below it. Vertical margin adds to the line's
  // height, and a block-level display breaks the line entirely — either one
  // grows the row after mount. These are the mutations the deleted
  // offsetHeight test claimed to catch and did not.
  //
  // `display` is deliberately NOT asserted here any more: it is no longer an
  // inline style. The component leaves it to mobile.css so the base hide can
  // win (an inline display outranked it and rendered "Draft" at every width).
  // The stylesheet side — that every reveal sets an inline-level display, and
  // that the component sets none — is covered by mobileDraftChip.test.ts and
  // DraftChip.test.tsx respectively.
  it('the marker contributes no vertical margin', () => {
    renderRow(false, { bill: { id: 'draft-1', isDraft: true, status: '', billNumber: 'D1' } })
    const s = screen.getByText('Draft', { selector: '.bill-title-draft-marker' }).style
    expect(s.display).toBe('')
    expect(parseFloat(s.marginTop) || 0).toBe(0)
    expect(parseFloat(s.marginBottom) || 0).toBe(0)
    expect(parseFloat(s.marginBlockStart) || 0).toBe(0)
    expect(parseFloat(s.marginBlockEnd) || 0).toBe(0)
    // `margin` shorthand, if used, must not introduce vertical margin either.
    if (s.margin) expect(s.margin).toMatch(/^0(px)?(\s|$)/)
  })
})

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
