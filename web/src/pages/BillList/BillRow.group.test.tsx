import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, fireEvent, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { BillRow } from './BillRow'
import type { Bill, GroupMember } from './types'

const navigateMock = vi.hoisted(() => vi.fn())
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom')
  return { ...actual, useNavigate: () => navigateMock }
})
vi.mock('../../context/ConfigContext', () => ({
  useConfig: () => ({ config: null, multiState: false, loading: false }),
  useMultiState: () => false,
}))
vi.mock('../../context/DemoContext', () => ({
  useDemo: () => ({ demoMode: false, demoLocked: false }),
}))

// A group is one row (#379): each bill's number and status stack in the cells
// the row already has, so the pairing reads by position and no column grows.

const member = (id: string, billNumber: string, status: string, over: Partial<GroupMember> = {}): GroupMember =>
  ({ id, billNumber, state: 'NJ', status, sessionSlug: '2026', ...over })

const S1713 = member('b1713', 'S1713', 'Passed')
const A190 = member('a190', 'A190', 'Introduced')

function makeBill(over: Partial<Bill> = {}): Bill {
  return {
    id: 'b1713', billNumber: 'S1713', title: 'Test bill', state: 'NJ', status: 'Passed',
    session: '2026 Regular Session', sessionSlug: '2026', sessionId: null, yearStart: 2026, yearEnd: 2027,
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

function renderRow(bill: Partial<Bill>, props: { filterStatuses?: string[]; onStatusClick?: (s: string) => void; onVote?: (id: string, p: 'support' | 'neutral' | 'oppose') => void } = {}) {
  return render(
    <MemoryRouter>
      <BillRow
        bill={makeBill(bill)}
        index={0}
        selectedTags={[]}
        onTagClick={vi.fn()}
        isAdmin={false}
        positionVocabulary={['Support', 'Oppose']}
        onStatusClick={props.onStatusClick ?? vi.fn()}
        onPriorityClick={vi.fn()}
        onPositionClick={vi.fn()}
        onRelevanceClick={vi.fn()}
        onPriorityChange={vi.fn()}
        onPositionChange={vi.fn()}
        onVote={props.onVote}
        filterStatuses={props.filterStatuses ?? []}
        filterPriorities={[]}
        filterPositions={[]}
        filterYears={[]}
        filterMinRelevance={0}
        sortedPaths={[]}
        isMultiState={false}
        isSelectionMode={false}
        isSelected={false}
        onToggleSelect={undefined}
      />
    </MemoryRouter>,
  )
}

const billCell = (container: HTMLElement) => container.querySelector('.bill-row-chips-cell')!.children[0] as HTMLElement
const statusCell = (container: HTMLElement) => container.querySelector('.bill-col-status') as HTMLElement

describe('a grouped BillRow', () => {
  afterEach(() => { navigateMock.mockClear() })

  it("stacks each bill's number in the bill cell, the furthest along first", () => {
    const { container } = renderRow({ group: [S1713, A190] })
    const numbers = within(billCell(container)).getAllByRole('link').map(a => a.textContent)
    expect(numbers).toEqual(['S1713', 'A190'])
  })

  it('links each number to its own bill', () => {
    const { container } = renderRow({ group: [S1713, A190] })
    const links = within(billCell(container)).getAllByRole('link')
    expect(links.map(a => a.getAttribute('href'))).toEqual(['/NJ/2026/S1713', '/NJ/2026/A190'])
  })

  it('opens the bill whose number is clicked, and the row opens the first one', () => {
    const { container } = renderRow({ group: [S1713, A190] })
    fireEvent.click(within(billCell(container)).getByRole('link', { name: 'A190' }))
    expect(navigateMock).toHaveBeenLastCalledWith('/NJ/2026/A190', expect.anything())
    fireEvent.click(container.querySelector('.bill-row-grid') as HTMLElement)
    expect(navigateMock).toHaveBeenLastCalledWith('/NJ/2026/S1713', expect.anything())
  })

  it('stacks each status in the status cell, in the order of the numbers', () => {
    const { container } = renderRow({ group: [S1713, A190] })
    expect(within(statusCell(container)).getAllByText(/Passed|Introduced/).map(c => c.textContent)).toEqual(['Passed', 'Introduced'])
  })

  it('collapses identical statuses to one', () => {
    const { container } = renderRow({ group: [S1713, member('a190', 'A190', 'Passed')] })
    expect(within(statusCell(container)).getAllByText('Passed')).toHaveLength(1)
    // Both numbers still show.
    expect(within(billCell(container)).getAllByRole('link')).toHaveLength(2)
  })

  it('highlights a status the filter names, on the bill that has it', () => {
    const { container } = renderRow({ group: [S1713, A190] }, { filterStatuses: ['Passed'] })
    const chips = within(statusCell(container)).getAllByText(/Passed|Introduced/)
    expect(chips).toHaveLength(2)
    const [passed, introduced] = chips
    expect(passed.style.outline).toContain('solid')
    expect(introduced.style.outline).not.toContain('solid')
  })

  it("filters by a status chip's own status", () => {
    const onStatusClick = vi.fn()
    const { container } = renderRow({ group: [S1713, A190] }, { onStatusClick })
    fireEvent.click(within(statusCell(container)).getByText('Introduced'))
    expect(onStatusClick).toHaveBeenCalledWith('Introduced')
  })

  it('shows the furthest-along bill, one other, and +N for a group larger than two', () => {
    const group = [S1713, A190, member('c1', 'S1715', 'Introduced'), member('c2', 'A192', 'Introduced')]
    const { container } = renderRow({ group })
    expect(within(billCell(container)).getAllByRole('link').map(a => a.textContent)).toEqual(['S1713', 'A190'])
    expect(within(billCell(container)).getByText('+2')).toBeInTheDocument()
    // The status cell keeps to the same two.
    expect(within(statusCell(container)).getAllByText(/Passed|Introduced/).map(c => c.textContent)).toEqual(['Passed', 'Introduced'])
  })

  it('shows the bill that matched the filter as the other one when the first bill did not', () => {
    const group = [{ ...S1713, matched: false }, { ...A190, matched: false }, { ...member('c1', 'S1715', 'Introduced'), matched: true }, { ...member('c2', 'A192', 'Introduced'), matched: false }]
    const { container } = renderRow({ group })
    const numbers = within(billCell(container)).getAllByRole('link').map(a => a.textContent)
    expect(numbers).toEqual(['S1713', 'S1715'])
    expect(within(billCell(container)).getByText('+2')).toBeInTheDocument()
    expect(container.querySelector('[data-matched]')?.textContent).toBe('S1715')
  })

  it('shows no +N for a group of two', () => {
    const { container } = renderRow({ group: [S1713, A190] })
    expect(within(billCell(container)).queryByText(/^\+\d/)).toBeNull()
  })

  it('names the bills +N stands for when hovered', () => {
    const group = [S1713, A190, member('c1', 'S1715', 'Introduced'), member('c2', 'A192', 'Introduced')]
    const { container } = renderRow({ group })
    fireEvent.pointerEnter(within(billCell(container)).getByText('+2'), { pointerType: 'mouse' })
    expect(screen.getAllByText(/S1715, A192/).length).toBeGreaterThan(0)
  })

  it('emphasizes the number of the bill that matched the filter', () => {
    const { container } = renderRow({ group: [{ ...S1713, matched: true }, { ...A190, matched: false }] })
    const [first, second] = within(billCell(container)).getAllByRole('link')
    expect(first.closest('[data-matched]')?.getAttribute('data-matched')).toBe('true')
    expect(second.closest('[data-matched]')).toBeNull()
  })

  it('emphasizes nothing when every bill in the group matched', () => {
    const { container } = renderRow({ group: [{ ...S1713, matched: true }, { ...A190, matched: true }] })
    expect(container.querySelector('[data-matched]')).toBeNull()
  })

  it('emphasizes nothing when no filter marked any bill', () => {
    const { container } = renderRow({ group: [S1713, A190] })
    expect(container.querySelector('[data-matched]')).toBeNull()
  })

  it('shows the same numbers and statuses in the phone row', () => {
    const { container } = renderRow({ group: [S1713, A190] })
    const meta = container.querySelector('.bill-row-mobile-meta') as HTMLElement
    expect(within(meta).getAllByRole('link').map(a => a.textContent)).toEqual(['S1713', 'A190'])
    expect(within(meta).getAllByText(/Passed|Introduced/).map(c => c.textContent)).toEqual(['Passed', 'Introduced'])
  })

  it("keeps the row's voting on the first bill", () => {
    const onVote = vi.fn()
    renderRow({ group: [S1713, A190] }, { onVote })
    fireEvent.click(screen.getByRole('button', { name: 'Support' }))
    expect(onVote).toHaveBeenCalledWith('b1713', 'support')
  })
})

describe('no column is wider for a group', () => {
  it('uses the same grid tracks and the same cells as a bill with no companions', () => {
    const lone = renderRow({ group: undefined })
    const loneChips = lone.container.querySelector('.bill-row-chips-cell') as HTMLElement
    const loneRow = lone.container.querySelector('.bill-row-grid') as HTMLElement
    const loneTracks = [loneChips.style.gridTemplateColumns, loneRow.style.gridTemplateColumns]
    const loneCells = loneChips.children.length
    lone.unmount()

    const grouped = renderRow({ group: [S1713, A190] })
    const chips = grouped.container.querySelector('.bill-row-chips-cell') as HTMLElement
    const row = grouped.container.querySelector('.bill-row-grid') as HTMLElement
    expect([chips.style.gridTemplateColumns, row.style.gridTemplateColumns]).toEqual(loneTracks)
    expect(chips.children.length).toBe(loneCells)
    // The second bill is in the same cells, not an added one.
    expect(billCell(grouped.container).querySelectorAll('a')).toHaveLength(2)
  })

  it('leaves a bill with no companions as it is: its number is not a link and nothing is stacked', () => {
    const { container } = renderRow({ group: undefined })
    expect(container.querySelector('[data-group-stack]')).toBeNull()
    expect(within(billCell(container)).queryAllByRole('link')).toHaveLength(0)
    expect(billCell(container).textContent).toBe('S1713')
  })
})
