import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, fireEvent, screen, within } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
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

function renderRow(bill: Partial<Bill>, props: { status?: string[]; onStatusClick?: (s: string) => void; onVote?: (id: string, p: 'support' | 'neutral' | 'oppose') => void } = {}) {
  return render(
    <MemoryRouter>
      <BillRow
        bill={makeBill(bill)}
        index={0}
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
        filter={{ status: props.status ?? [], priority: [], position: [], year: [], minRelevance: 0, tag: [] }}
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
    const { container } = renderRow({ group: [S1713, A190] }, { status: ['Passed'] })
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

  it('opens the +N list on a click or tap instead of opening the bill, and closes it on a second click', () => {
    const group = [S1713, A190, member('c1', 'S1715', 'Introduced'), member('c2', 'A192', 'Introduced')]
    const { container } = renderRow({ group })
    const more = within(billCell(container)).getByRole('button', { name: '+2' })
    expect(more.style.cursor).toBe('pointer')
    fireEvent.click(more)
    expect(screen.getByRole('tooltip')).toHaveTextContent('Also S1715, A192')
    expect(navigateMock).not.toHaveBeenCalled()
    fireEvent.click(more)
    expect(screen.queryByRole('tooltip')).toBeNull()
    expect(navigateMock).not.toHaveBeenCalled()
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

// A status sits level with its own bill's number. The numbers and the statuses
// are cells of different columns, so each is drawn on a row of one shared grid:
// the chips cell has a row per shown bill (plus one for "+N"), and the number
// and status cells are subgrids of it. jsdom does no layout, so these check the
// rows each piece is given; groupRows.test.ts checks how they are chosen.

const chipsCell = (container: HTMLElement) => container.querySelector('.bill-row-chips-cell') as HTMLElement
const items = (scope: HTMLElement, kind: string) => [...scope.querySelectorAll<HTMLElement>(`[data-group-item="${kind}"]`)]
const rowsOf = (els: HTMLElement[]) => els.map(el => el.style.gridRow)
const FOUR = [S1713, A190, member('c1', 'S1715', 'Introduced'), member('c2', 'A192', 'Introduced')]

describe('a grouped BillRow: bills and statuses on shared rows', () => {
  it('lays the chips cell out on one row per shown bill', () => {
    const { container } = renderRow({ group: [S1713, A190] })
    expect(chipsCell(container).style.gridTemplateRows).toBe('repeat(2, auto)')
    expect(chipsCell(container).dataset.groupRows).toBe('2')
  })

  it('adds a row below the bills for "+N"', () => {
    const { container } = renderRow({ group: FOUR })
    expect(chipsCell(container).style.gridTemplateRows).toBe('repeat(3, auto)')
  })

  it('keeps the column gap between chips and closes the row gap to the stack\'s 4px', () => {
    const { container } = renderRow({ group: [S1713, A190] })
    expect(chipsCell(container).style.columnGap).toBe('16px')
    expect(chipsCell(container).style.rowGap).toBe('4px')
  })

  it("puts each status on its own bill's row when the statuses differ", () => {
    const { container } = renderRow({ group: [S1713, A190] })
    const numbers = items(billCell(container), 'number')
    const statuses = items(statusCell(container), 'status')
    expect(rowsOf(numbers)).toEqual(['1', '2'])
    expect(rowsOf(statuses)).toEqual(['1', '2'])
    expect(numbers.map(n => n.textContent)).toEqual(['S1713', 'A190'])
    expect(statuses.map(s => s.textContent)).toEqual(['Passed', 'Introduced'])
  })

  it('centers each number and each status on its row', () => {
    const { container } = renderRow({ group: [S1713, A190] })
    const placed = [...items(billCell(container), 'number'), ...items(statusCell(container), 'status')]
    expect(placed).toHaveLength(4)
    for (const el of placed) expect(el.style.alignSelf).toBe('center')
  })

  it('spreads one shared status across both chip rows', () => {
    const { container } = renderRow({ group: [S1713, member('a190', 'A190', 'Passed')] })
    const statuses = items(statusCell(container), 'status')
    expect(statuses).toHaveLength(1)
    expect(statuses[0].style.gridRow).toBe('1 / span 2')
    expect(statuses[0].style.alignSelf).toBe('center')
    expect(rowsOf(items(billCell(container), 'number'))).toEqual(['1', '2'])
  })

  it('draws "+N" on the row below the bills, outside the status alignment (distinct statuses)', () => {
    const { container } = renderRow({ group: FOUR })
    const more = items(billCell(container), 'more')
    expect(more).toHaveLength(1)
    expect(more[0].style.gridRow).toBe('3')
    expect(more[0]).toHaveTextContent('+2')
    expect(rowsOf(items(statusCell(container), 'status'))).toEqual(['1', '2'])
  })

  it('draws "+N" on the row below the bills, outside the status alignment (shared status)', () => {
    const group = [S1713, member('a190', 'A190', 'Passed'), member('c1', 'S1715', 'Passed')]
    const { container } = renderRow({ group })
    expect(items(billCell(container), 'more')[0].style.gridRow).toBe('3')
    expect(rowsOf(items(statusCell(container), 'status'))).toEqual(['1 / span 2'])
  })

  it('draws no "+N" row for a group of two', () => {
    const { container } = renderRow({ group: [S1713, A190] })
    expect(items(billCell(container), 'number')).toHaveLength(2)
    expect(items(billCell(container), 'more')).toHaveLength(0)
  })

  it('makes the number and status cells subgrids spanning every row', () => {
    const { container } = renderRow({ group: FOUR })
    for (const cell of [billCell(container), statusCell(container)]) {
      expect(cell.style.display).toBe('grid')
      expect(cell.style.gridTemplateRows).toBe('subgrid')
      expect(cell.style.gridRow).toBe('1 / -1')
    }
  })

  it('keeps the status cell the one the narrow-width rules hide', () => {
    const { container } = renderRow({ group: [S1713, A190] })
    expect(statusCell(container).classList.contains('bill-col-status')).toBe(true)
  })

  it('leaves a bill with no companions alone: no rows, no subgrids, no grouped items', () => {
    const { container } = renderRow({ group: undefined })
    expect(chipsCell(container).style.gridTemplateRows).toBe('')
    expect(chipsCell(container).dataset.groupRows).toBeUndefined()
    expect(chipsCell(container).style.gap).toBe('16px')
    expect(container.querySelector('[data-group-item]')).toBeNull()
    expect(statusCell(container).style.display).toBe('flex')
    expect(statusCell(container).style.gridTemplateRows).toBe('')
  })

  it("lets the cells it doesn't place (year, last action, relevance) span every row, centered on the whole group", () => {
    const css = readFileSync(join(__dirname, '../../styles/mobile.css'), 'utf8')
    expect(css).toMatch(/\.bill-row-chips-cell\[data-group-rows\]\s*>\s*\*\s*\{[^}]*grid-row:\s*1\s*\/\s*-1/)
  })
})

describe('a grouped BillRow: the phone row', () => {
  const pairs = (container: HTMLElement) => container.querySelector('.bill-row-mobile-meta [data-group-pairs]') as HTMLElement

  it("puts each status beside its own bill's number, in two columns", () => {
    const { container } = renderRow({ group: [S1713, A190] })
    const grid = pairs(container)
    expect(grid.style.display).toBe('inline-grid')
    const numbers = items(grid, 'number')
    const statuses = items(grid, 'status')
    expect(numbers.map(n => [n.style.gridColumn, n.style.gridRow])).toEqual([['1', '1'], ['1', '2']])
    expect(statuses.map(s => [s.style.gridColumn, s.style.gridRow])).toEqual([['2', '1'], ['2', '2']])
    expect(statuses.map(s => s.textContent)).toEqual(['Passed', 'Introduced'])
  })

  it('centers a shared status across both bills', () => {
    const { container } = renderRow({ group: [S1713, member('a190', 'A190', 'Passed')] })
    const statuses = items(pairs(container), 'status')
    expect(statuses).toHaveLength(1)
    expect(statuses[0].style.gridRow).toBe('1 / span 2')
    expect(statuses[0].style.alignSelf).toBe('center')
  })

  it('draws "+N" under the numbers, on its own row', () => {
    const { container } = renderRow({ group: FOUR })
    const more = items(pairs(container), 'more')
    expect(more).toHaveLength(1)
    expect([more[0].style.gridColumn, more[0].style.gridRow]).toEqual(['1', '3'])
  })

  it('draws no pair grid for a bill with no companions', () => {
    const { container } = renderRow({ group: undefined })
    expect(container.querySelector('[data-group-pairs]')).toBeNull()
  })

  it('keeps the status chips of the phone row inert, as before', () => {
    const onStatusClick = vi.fn()
    const { container } = renderRow({ group: [S1713, A190] }, { onStatusClick })
    fireEvent.click(within(pairs(container)).getByText('Introduced'))
    expect(onStatusClick).not.toHaveBeenCalled()
  })
})
