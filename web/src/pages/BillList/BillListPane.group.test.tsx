import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, within, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { Bill, GroupMember } from './types'

// A companion group's row in the split pane: each status level with its own
// bill's number, a shared status centered across the bills, "+N" below, and the
// group's priority square on every number. jsdom does no layout, so these check
// the rows and columns each piece is given, as BillRow.group.test.tsx does for
// the Bills page.

const hoisted = vi.hoisted(() => ({
  respond: null as null | ((path: string) => unknown),
}))

vi.mock('../../lib/api', () => ({
  apiFetch: async (path: string) => {
    const out = hoisted.respond ? hoisted.respond(path) : {}
    if (out instanceof Error) throw out
    return out
  },
  ApiError: class ApiError extends Error {},
}))
vi.mock('../../context/ConfigContext', () => ({
  useConfig: () => ({ config: null, multiState: false, loading: false }),
  useMultiState: () => false,
}))
vi.mock('./index', () => ({
  peekBillsListCache: () => null,
  peekCustomFieldDefs: () => [],
}))

import { BillListPane } from './BillListPane'

const STORAGE_KEY = 'billListPaneWidth'

const member = (id: string, billNumber: string, status: string): GroupMember =>
  ({ id, billNumber, state: 'RI', status, sessionSlug: '2026' })

function bill(id: string, billNumber: string, over: Partial<Bill> = {}): Bill {
  return {
    id, billNumber, title: `Title of ${billNumber}`, state: 'RI', status: 'Introduced',
    session: '2026', sessionSlug: '2026', sessionId: null, yearStart: 2026, yearEnd: 2026,
    abstract: null, url: null, stateUrl: null, lastAction: null, lastActionDate: null, tenantSummary: null,
    tags: [], priority: null, matchType: null, isDraft: false, position: null, relevanceScore: null,
    aiProcessedAt: null, newMatchAt: null, triagedAt: null,
    voteCounts: { support: 0, oppose: 0, neutral: 0 }, myVote: null,
    commentCount: 0, hasNote: false, hasComment: false, updatedAt: '2026-01-01 00:00:00',
    customFieldValues: {}, ...over,
  }
}

// Two shown with different statuses, one behind "+1".
const DISTINCT = bill('g1', 'S 5', {
  status: 'Passed', priority: 'high',
  group: [member('g1', 'S 5', 'Passed'), member('g2', 'H 5', 'Introduced'), member('g3', 'H 6', 'Referred')],
})
// Two shown with one status, nothing behind "+N".
const SHARED = bill('p1', 'S 9', {
  status: 'Introduced', priority: 'medium',
  group: [member('p1', 'S 9', 'Introduced'), member('p2', 'H 9', 'Introduced')],
})
// One shared status and a "+N".
const SHARED_MORE = bill('m1', 'S 7', {
  status: 'Passed', priority: 'low',
  group: [member('m1', 'S 7', 'Passed'), member('m2', 'H 7', 'Passed'), member('m3', 'H 8', 'Passed'), member('m4', 'H 9X', 'Passed')],
})
// A group with no priority.
const NO_PRIORITY = bill('n1', 'S 11', {
  status: 'Passed',
  group: [member('n1', 'S 11', 'Passed'), member('n2', 'H 11', 'Introduced')],
})
const PLAIN = bill('b1', 'HB 1', { priority: 'high' })

function page(bills: Bill[]) {
  return { bills, pagination: { page: 1, pageSize: 100, total: bills.length, totalPages: 1 } }
}

const realInnerWidth = window.innerWidth
function setWindow(width: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: width })
  act(() => { window.dispatchEvent(new Event('resize')) })
}

async function ready() {
  render(<MemoryRouter initialEntries={['/RI/2026/HB%201']}><BillListPane /></MemoryRouter>)
  const pane = await screen.findByRole('navigation', { name: 'Bill list' })
  await within(pane).findByText('Title of HB 1')
  return pane
}
const rowOf = (pane: HTMLElement, text: RegExp) => within(pane).getByRole('link', { name: text })
const cell = (row: HTMLElement, col: string) => row.querySelector(`[data-pane-col="${col}"]`) as HTMLElement
const items = (scope: HTMLElement, kind: string) => [...scope.querySelectorAll<HTMLElement>(`[data-group-item="${kind}"]`)]
const rowsOf = (els: HTMLElement[]) => els.map(el => el.style.gridRow)
const gridOf = (row: HTMLElement) => row.querySelector('[data-pane-grid]') as HTMLElement
const numberCell = (row: HTMLElement) => gridOf(row).children[0] as HTMLElement
const hasSquare = (badge: Element) => !!badge.querySelector('span[aria-hidden="true"]')
const badgeOf = (row: HTMLElement, text: string) => within(row).getByText(text)

beforeEach(() => {
  hoisted.respond = (path) => path.startsWith('/bills?') ? page([PLAIN, DISTINCT, SHARED, SHARED_MORE, NO_PRIORITY]) : {}
  sessionStorage.clear()
  localStorage.clear()
  Element.prototype.scrollIntoView = vi.fn()
  setWindow(1600)
})
afterEach(() => {
  vi.restoreAllMocks()
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: realInnerWidth })
})

describe('a group row in a wide pane (status column showing)', () => {
  beforeEach(() => { localStorage.setItem(STORAGE_KEY, '660') })

  it('lays the row out on one row per shown bill, plus one for "+N"', async () => {
    const pane = await ready()
    expect(gridOf(rowOf(pane, /Title of S 5/)).style.gridTemplateRows).toBe('repeat(3, auto)')
    expect(gridOf(rowOf(pane, /Title of S 9/)).style.gridTemplateRows).toBe('repeat(2, auto)')
  })

  it("keeps the column gap and closes the row gap to the stack's 4px", async () => {
    const pane = await ready()
    const grid = gridOf(rowOf(pane, /Title of S 5/))
    expect(grid.style.columnGap).toBe('8px')
    expect(grid.style.rowGap).toBe('4px')
  })

  it("puts each status on its own bill's row when the statuses differ", async () => {
    const pane = await ready()
    const row = rowOf(pane, /Title of S 5/)
    expect(rowsOf(items(numberCell(row), 'number'))).toEqual(['1', '2'])
    const statuses = items(cell(row, 'status'), 'status')
    expect(rowsOf(statuses)).toEqual(['1', '2'])
    expect(statuses.map(s => s.textContent)).toEqual(['Passed', 'Introduced'])
  })

  it('centers each number and status on its row', async () => {
    const pane = await ready()
    const row = rowOf(pane, /Title of S 5/)
    const placed = [...items(numberCell(row), 'number'), ...items(cell(row, 'status'), 'status')]
    expect(placed).toHaveLength(4)
    for (const el of placed) expect(el.style.alignSelf).toBe('center')
  })

  it('centers one shared status across the bill rows', async () => {
    const pane = await ready()
    const row = rowOf(pane, /Title of S 9/)
    const statuses = items(cell(row, 'status'), 'status')
    expect(statuses).toHaveLength(1)
    expect(statuses[0].style.gridRow).toBe('1 / span 2')
    expect(statuses[0].style.alignSelf).toBe('center')
  })

  it('spans only the bill rows, not the "+N" row, for a shared status', async () => {
    const pane = await ready()
    const row = rowOf(pane, /Title of S 7/)
    expect(rowsOf(items(cell(row, 'status'), 'status'))).toEqual(['1 / span 2'])
    const more = items(numberCell(row), 'more')
    expect(more).toHaveLength(1)
    expect(more[0].style.gridRow).toBe('3')
  })

  it('draws "+N" on the row below the numbers and gives no status that row', async () => {
    const pane = await ready()
    const row = rowOf(pane, /Title of S 5/)
    const more = items(numberCell(row), 'more')
    expect(more).toHaveLength(1)
    expect(more[0].style.gridRow).toBe('3')
    expect(more[0]).toHaveTextContent('+1')
    expect(rowsOf(items(cell(row, 'status'), 'status'))).not.toContain('3')
  })

  it('draws no "+N" row for a group of two', async () => {
    const pane = await ready()
    const row = rowOf(pane, /Title of S 9/)
    expect(items(numberCell(row), 'number')).toHaveLength(2)
    expect(items(numberCell(row), 'more')).toHaveLength(0)
  })

  it('makes the number and status cells subgrids spanning every row', async () => {
    const pane = await ready()
    const row = rowOf(pane, /Title of S 5/)
    for (const c of [numberCell(row), cell(row, 'status')]) {
      expect(c.style.display).toBe('grid')
      expect(c.style.gridTemplateRows).toBe('subgrid')
      expect(c.style.gridRow).toBe('1 / -1')
    }
  })

  it('lets the other columns span every row, as they did when stacked', async () => {
    const pane = await ready()
    const row = rowOf(pane, /Title of S 5/)
    for (const col of ['year', 'lastAction']) expect(cell(row, col).style.gridRow).toBe('1 / -1')
  })

  it('keeps every row\'s cells in the header\'s columns', async () => {
    const pane = await ready()
    const header = pane.querySelector('[data-pane-columns] [data-pane-grid]') as HTMLElement
    for (const text of [/Title of S 5/, /Title of S 9/, /Title of S 7/]) {
      expect(gridOf(rowOf(pane, text)).style.gridTemplateColumns).toBe(header.style.gridTemplateColumns)
    }
  })

  it('leaves a bill with no companions as it was', async () => {
    const pane = await ready()
    const row = rowOf(pane, /Title of HB 1/)
    expect(gridOf(row).style.gridTemplateRows).toBe('')
    expect(gridOf(row).style.alignItems).toBe('center')
    expect(row.querySelector('[data-group-item]')).toBeNull()
    expect(cell(row, 'status').style.display).toBe('flex')
    expect(cell(row, 'status').style.gridTemplateRows).toBe('')
  })
})

describe('a group row in a narrow pane (status at the right)', () => {
  beforeEach(() => { localStorage.setItem(STORAGE_KEY, '300') })
  const pairs = (row: HTMLElement) => row.querySelector('[data-group-pairs]') as HTMLElement

  it("puts each status level with its own bill's number, in two columns", async () => {
    const pane = await ready()
    const grid = pairs(rowOf(pane, /Title of S 5/))
    expect(grid.style.display).toBe('grid')
    const numbers = items(grid, 'number')
    const statuses = items(grid, 'status')
    expect(numbers.map(n => [n.style.gridColumn, n.style.gridRow])).toEqual([['1', '1'], ['1', '2']])
    expect(statuses.map(s => [s.style.gridColumn, s.style.gridRow])).toEqual([['2', '1'], ['2', '2']])
    expect(statuses.map(s => s.textContent)).toEqual(['Passed', 'Introduced'])
  })

  it('keeps the statuses at the right edge of the row', async () => {
    const pane = await ready()
    const grid = pairs(rowOf(pane, /Title of S 5/))
    expect(grid.style.width).toBe('100%')
    for (const s of items(grid, 'status')) expect(s.style.justifySelf).toBe('end')
    for (const n of items(grid, 'number')) expect(n.style.justifySelf).toBe('start')
  })

  it('centers one shared status across the bills', async () => {
    const pane = await ready()
    const statuses = items(pairs(rowOf(pane, /Title of S 9/)), 'status')
    expect(statuses).toHaveLength(1)
    expect(statuses[0].style.gridRow).toBe('1 / span 2')
    expect(statuses[0].style.alignSelf).toBe('center')
  })

  it('draws "+N" under the numbers, on a row of its own', async () => {
    const pane = await ready()
    const more = items(pairs(rowOf(pane, /Title of S 5/)), 'more')
    expect(more).toHaveLength(1)
    expect([more[0].style.gridColumn, more[0].style.gridRow]).toEqual(['1', '3'])
  })

  it('spreads a shared status over the bill rows only when "+N" follows', async () => {
    const pane = await ready()
    const statuses = items(pairs(rowOf(pane, /Title of S 7/)), 'status')
    expect(rowsOf(statuses)).toEqual(['1 / span 2'])
  })

  it('draws no pair grid for a bill with no companions, which keeps its single status at the right', async () => {
    const pane = await ready()
    const row = rowOf(pane, /Title of HB 1/)
    expect(pairs(row)).toBeNull()
    expect(row).toHaveTextContent('Introduced')
  })

  it('still tells a screen reader the group\'s priority once', async () => {
    const pane = await ready()
    const row = rowOf(pane, /Title of S 5/)
    expect(row.textContent?.match(/high priority/g)).toHaveLength(1)
  })
})

describe.each([
  ['a wide pane', '660'],
  ['a narrow pane', '300'],
])('the priority square on a group row in %s', (_name, width) => {
  beforeEach(() => { localStorage.setItem(STORAGE_KEY, width) })

  it("is drawn on every number shown, since the priority is the group's", async () => {
    const pane = await ready()
    const row = rowOf(pane, /Title of S 5/)
    expect(hasSquare(badgeOf(row, 'S 5'))).toBe(true)
    expect(hasSquare(badgeOf(row, 'H 5'))).toBe(true)
  })

  it('is the same color on each number', async () => {
    const pane = await ready()
    const row = rowOf(pane, /Title of S 5/)
    const color = (text: string) => (badgeOf(row, text).querySelector('span[aria-hidden="true"]') as HTMLElement).style.background
    expect(color('S 5')).not.toBe('')
    expect(color('H 5')).toBe(color('S 5'))
  })

  it('differs by the group\'s priority, not by the bill', async () => {
    const pane = await ready()
    const square = (text: RegExp, number: string) =>
      (badgeOf(rowOf(pane, text), number).querySelector('span[aria-hidden="true"]') as HTMLElement).style.background
    expect(square(/Title of S 5/, 'S 5')).not.toBe(square(/Title of S 9/, 'S 9'))
    expect(square(/Title of S 9/, 'H 9')).toBe(square(/Title of S 9/, 'S 9'))
  })

  it('is drawn on every number of a group with a "+N" too', async () => {
    const pane = await ready()
    const row = rowOf(pane, /Title of S 7/)
    expect(hasSquare(badgeOf(row, 'S 7'))).toBe(true)
    expect(hasSquare(badgeOf(row, 'H 7'))).toBe(true)
  })

  it('is drawn on no number of a group with no priority', async () => {
    const pane = await ready()
    const row = rowOf(pane, /Title of S 11/)
    expect(hasSquare(badgeOf(row, 'S 11'))).toBe(false)
    expect(hasSquare(badgeOf(row, 'H 11'))).toBe(false)
  })

  it('is still on a lone bill\'s number', async () => {
    const pane = await ready()
    expect(hasSquare(badgeOf(rowOf(pane, /Title of HB 1/), 'HB 1'))).toBe(true)
  })

  it('does not appear on the "+N" line', async () => {
    const pane = await ready()
    const more = items(rowOf(pane, /Title of S 5/), 'more')[0]
    expect(more.querySelector('span[aria-hidden="true"]')?.textContent ?? '').toBe('+1')
    expect(more.querySelector('[style*="box-shadow"]')).toBeNull()
  })
})
