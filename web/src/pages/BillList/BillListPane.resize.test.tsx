import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, within, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { color } from '../../styles/tokens'
import { RelevanceChip } from '../../components/RelevanceChip'
import { SessionChip } from '../../components/SessionChip'
import { StatusChip } from '../../components/StatusChip'
import { LastActionChip } from '../../components/LastActionChip'
import { decodeStatus } from '../../lib/legislativeStatus'
import type { Bill, GroupMember } from './types'

// The split pane's width, resize handle, and columns (#597). The pane is
// rendered on its own, as in BillListPane.test.tsx, with a scripted /bills
// response; the window's width is set per test because the pane's maximum
// follows it.

const hoisted = vi.hoisted(() => ({
  respond: null as null | ((path: string) => unknown),
  multi: false,
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
  useConfig: () => ({ config: null, multiState: hoisted.multi, loading: false }),
  useMultiState: () => hoisted.multi,
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

const FULL = bill('b1', 'HB 1', {
  status: 'Passed', yearStart: 2025, yearEnd: 2026, lastActionDate: '2026-03-04', relevanceScore: 7, priority: 'high',
})
const BARE = bill('b2', 'HB 2', { status: 'Introduced', yearStart: null, yearEnd: null, lastActionDate: null, relevanceScore: null })
const DRAFT = bill('b3', 'HB 3', { isDraft: true, status: 'Draft' })
const GROUP = bill('g1', 'S 5', {
  status: 'Passed',
  group: [member('g1', 'S 5', 'Passed'), member('g2', 'H 5', 'Introduced'), member('g3', 'H 6', 'Referred')],
})

function page(bills: Bill[]) {
  return { bills, pagination: { page: 1, pageSize: 100, total: bills.length, totalPages: 1 } }
}

const realInnerWidth = window.innerWidth
function setWindow(width: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: width })
  act(() => { window.dispatchEvent(new Event('resize')) })
}

function renderPane(path = '/RI/2026/HB%201') {
  return render(<MemoryRouter initialEntries={[path]}><BillListPane /></MemoryRouter>)
}
async function ready() {
  const pane = await screen.findByRole('navigation', { name: 'Bill list' })
  await within(pane).findByText('Title of HB 1')
  return pane
}
const paneEl = () => screen.getByRole('navigation', { name: 'Bill list' })
const separator = () => within(paneEl()).getByRole('separator')
const widthOf = () => paneEl().style.width
const colHeaders = (pane: HTMLElement) =>
  Array.from(pane.querySelectorAll('[data-pane-col-header]')).map(e => e.getAttribute('data-pane-col-header'))
const rowOf = (pane: HTMLElement, text: RegExp) => within(pane).getByRole('link', { name: text })
const cell = (row: HTMLElement, col: string) => row.querySelector(`[data-pane-col="${col}"]`) as HTMLElement | null

function drag(from: number, to: number) {
  fireEvent.pointerDown(separator(), { clientX: from, button: 0, pointerId: 1 })
  fireEvent.pointerMove(document, { clientX: to, pointerId: 1 })
}
function drop(at: number) { fireEvent.pointerUp(document, { clientX: at, pointerId: 1 }) }

beforeEach(() => {
  hoisted.multi = false
  hoisted.respond = (path) => path.startsWith('/bills?') ? page([FULL, BARE, DRAFT, GROUP]) : {}
  sessionStorage.clear()
  localStorage.clear()
  Element.prototype.scrollIntoView = vi.fn()
  setWindow(1600)
})
afterEach(() => {
  vi.restoreAllMocks()
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: realInnerWidth })
  document.body.style.cursor = ''
  document.body.style.userSelect = ''
})

describe('resize handle', () => {
  it('is a labelled, focusable vertical separator carrying the pane\'s width and bounds', async () => {
    renderPane()
    await ready()
    const sep = separator()
    expect(sep).toHaveAttribute('aria-label', 'Resize bill list')
    expect(sep).toHaveAttribute('aria-orientation', 'vertical')
    expect(sep).toHaveAttribute('tabindex', '0')
    expect(sep).toHaveAttribute('aria-valuenow', '300')
    expect(sep).toHaveAttribute('aria-valuemin', '300')
    expect(sep).toHaveAttribute('aria-valuemax', '670')
  })

  it('sits on the pane\'s right edge without taking part in the layout', async () => {
    renderPane()
    await ready()
    const sep = separator()
    expect(sep.parentElement).toBe(paneEl())
    expect(sep.style.position).toBe('absolute')
    expect(sep.style.right).toBe('0px')
    expect(sep.style.top).toBe('0px')
    expect(sep.style.bottom).toBe('0px')
    expect(sep.style.cursor).toBe('col-resize')
  })

  it('is there while the list loads and after an error, so the width can be set early', async () => {
    hoisted.respond = () => new Error('boom')
    renderPane()
    await screen.findByText('Couldn’t load bills.')
    expect(separator()).toBeInTheDocument()
  })

  it('shows a Honey line on focus, and not at rest', async () => {
    renderPane()
    await ready()
    const sep = separator()
    const line = () => sep.querySelector('[data-resize-line]') as HTMLElement
    expect(line().style.background).not.toBe(color.accentAmber)
    fireEvent.focus(sep)
    expect(line().style.background).toBe(color.accentAmber)
    fireEvent.blur(sep)
    expect(line().style.background).not.toBe(color.accentAmber)
  })

  it('never uses the legacy amber', async () => {
    renderPane()
    await ready()
    expect(paneEl().innerHTML.toLowerCase()).not.toContain('#f59e0b')
  })
})

describe('resizing by drag', () => {
  it('follows the pointer from where the drag started', async () => {
    renderPane()
    await ready()
    drag(300, 450)
    expect(widthOf()).toBe('450px')
    expect(separator()).toHaveAttribute('aria-valuenow', '450')
    drop(450)
  })

  it('moves by the distance dragged, not to the pointer\'s position', async () => {
    renderPane()
    await ready()
    drag(298, 398)
    expect(widthOf()).toBe('400px')
    drop(398)
  })

  it('stops at the maximum', async () => {
    renderPane()
    await ready()
    drag(300, 5000)
    expect(widthOf()).toBe('670px')
    drop(5000)
  })

  it('stops at the minimum', async () => {
    renderPane()
    await ready()
    drag(300, 450)
    fireEvent.pointerMove(document, { clientX: -200, pointerId: 1 })
    expect(widthOf()).toBe('300px')
    drop(-200)
  })

  it('keeps following after hitting a bound, from the pointer, not from the bound', async () => {
    renderPane()
    await ready()
    drag(300, 5000)
    fireEvent.pointerMove(document, { clientX: 500, pointerId: 1 })
    expect(widthOf()).toBe('500px')
    drop(500)
  })

  it('drags from an already widened pane', async () => {
    localStorage.setItem(STORAGE_KEY, '500')
    renderPane()
    await ready()
    drag(500, 540)
    expect(widthOf()).toBe('540px')
    drop(540)
  })

  it('remembers the width when the drag ends, not before', async () => {
    renderPane()
    await ready()
    drag(300, 480)
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
    drop(480)
    expect(localStorage.getItem(STORAGE_KEY)).toBe('480')
  })

  it('stops following once the pointer is released', async () => {
    renderPane()
    await ready()
    drag(300, 450)
    drop(450)
    fireEvent.pointerMove(document, { clientX: 600, pointerId: 1 })
    expect(widthOf()).toBe('450px')
  })

  it('shows a col-resize cursor and blocks text selection only while dragging', async () => {
    renderPane()
    await ready()
    fireEvent.pointerDown(separator(), { clientX: 300, button: 0, pointerId: 1 })
    expect(document.body.style.cursor).toBe('col-resize')
    expect(document.body.style.userSelect).toBe('none')
    drop(300)
    expect(document.body.style.cursor).toBe('')
    expect(document.body.style.userSelect).toBe('')
  })

  it('ignores a right-button press', async () => {
    renderPane()
    await ready()
    fireEvent.pointerDown(separator(), { clientX: 300, button: 2, pointerId: 1 })
    fireEvent.pointerMove(document, { clientX: 450, pointerId: 1 })
    expect(widthOf()).toBe('300px')
  })

  it('does not navigate or select a row while dragging', async () => {
    renderPane()
    await ready()
    const down = fireEvent.pointerDown(separator(), { clientX: 300, button: 0, pointerId: 1 })
    expect(down).toBe(false) // preventDefault was called
    drop(300)
  })

  it('stops listening when the pane unmounts mid-drag', async () => {
    const { unmount } = renderPane()
    await ready()
    fireEvent.pointerDown(separator(), { clientX: 300, button: 0, pointerId: 1 })
    unmount()
    expect(document.body.style.cursor).toBe('')
    expect(() => fireEvent.pointerMove(document, { clientX: 400, pointerId: 1 })).not.toThrow()
  })
})

describe('resizing by keyboard', () => {
  it('ArrowRight widens by 16px and ArrowLeft narrows by 16px', async () => {
    renderPane()
    await ready()
    fireEvent.keyDown(separator(), { key: 'ArrowRight' })
    expect(widthOf()).toBe('316px')
    fireEvent.keyDown(separator(), { key: 'ArrowRight' })
    expect(widthOf()).toBe('332px')
    fireEvent.keyDown(separator(), { key: 'ArrowLeft' })
    expect(widthOf()).toBe('316px')
    expect(separator()).toHaveAttribute('aria-valuenow', '316')
  })

  it('does not go below the minimum or above the maximum', async () => {
    renderPane()
    await ready()
    fireEvent.keyDown(separator(), { key: 'ArrowLeft' })
    expect(widthOf()).toBe('300px')
    fireEvent.keyDown(separator(), { key: 'End' })
    fireEvent.keyDown(separator(), { key: 'ArrowRight' })
    expect(widthOf()).toBe('670px')
  })

  it('Home goes to the minimum and End to the maximum', async () => {
    renderPane()
    await ready()
    fireEvent.keyDown(separator(), { key: 'End' })
    expect(widthOf()).toBe('670px')
    fireEvent.keyDown(separator(), { key: 'Home' })
    expect(widthOf()).toBe('300px')
  })

  it('remembers each step', async () => {
    renderPane()
    await ready()
    fireEvent.keyDown(separator(), { key: 'ArrowRight' })
    expect(localStorage.getItem(STORAGE_KEY)).toBe('316')
    fireEvent.keyDown(separator(), { key: 'End' })
    expect(localStorage.getItem(STORAGE_KEY)).toBe('670')
  })

  it('keeps the page from scrolling on a key it handles, and leaves other keys alone', async () => {
    renderPane()
    await ready()
    expect(fireEvent.keyDown(separator(), { key: 'ArrowRight' })).toBe(false)
    expect(fireEvent.keyDown(separator(), { key: 'Home' })).toBe(false)
    expect(fireEvent.keyDown(separator(), { key: 'Tab' })).toBe(true)
    expect(fireEvent.keyDown(separator(), { key: 'ArrowUp' })).toBe(true)
    expect(widthOf()).toBe('300px')
  })

  it('takes the keyboard where focus is: the separator is reachable by Tab', async () => {
    renderPane()
    await ready()
    separator().focus()
    expect(document.activeElement).toBe(separator())
  })
})

describe('double-click reset', () => {
  it('returns to 300px and forgets the stored width', async () => {
    localStorage.setItem(STORAGE_KEY, '560')
    renderPane()
    await ready()
    expect(widthOf()).toBe('560px')
    fireEvent.doubleClick(separator())
    expect(widthOf()).toBe('300px')
    expect(separator()).toHaveAttribute('aria-valuenow', '300')
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
  })

  it('stays reset on the next mount', async () => {
    localStorage.setItem(STORAGE_KEY, '560')
    const first = renderPane()
    await ready()
    fireEvent.doubleClick(separator())
    first.unmount()
    renderPane()
    await ready()
    expect(widthOf()).toBe('300px')
  })

  it('does nothing harmful when already at 300px', async () => {
    renderPane()
    await ready()
    fireEvent.doubleClick(separator())
    expect(widthOf()).toBe('300px')
  })
})

describe('remembering the width', () => {
  it('restores the stored width on the next mount', async () => {
    const first = renderPane()
    await ready()
    fireEvent.keyDown(separator(), { key: 'End' })
    first.unmount()
    renderPane()
    await ready()
    expect(widthOf()).toBe('670px')
  })

  it('clamps a stored width larger than the current maximum', async () => {
    localStorage.setItem(STORAGE_KEY, '2400')
    renderPane()
    await ready()
    expect(widthOf()).toBe('670px')
    expect(separator()).toHaveAttribute('aria-valuenow', '670')
  })

  it('clamps a stored width smaller than the minimum', async () => {
    localStorage.setItem(STORAGE_KEY, '120')
    renderPane()
    await ready()
    expect(widthOf()).toBe('300px')
  })

  it('uses 300px for a garbage stored value', async () => {
    localStorage.setItem(STORAGE_KEY, 'wide')
    renderPane()
    await ready()
    expect(widthOf()).toBe('300px')
  })

  it('narrows with a smaller window and wins its width back when the window grows again', async () => {
    localStorage.setItem(STORAGE_KEY, '640')
    renderPane()
    await ready()
    expect(widthOf()).toBe('640px')
    setWindow(1440)
    expect(widthOf()).toBe('510px')
    expect(separator()).toHaveAttribute('aria-valuemax', '510')
    expect(localStorage.getItem(STORAGE_KEY)).toBe('640') // the choice itself is kept
    setWindow(1600)
    expect(widthOf()).toBe('640px')
  })

  it('leaves room for a sidebar dragged wider than the default', async () => {
    localStorage.setItem('sidebarWidth', '400')
    renderPane()
    await ready()
    expect(separator()).toHaveAttribute('aria-valuemax', '500')
  })

  it('works when localStorage cannot be read: starts at 300px', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation((k) => {
      if (k === 'lastBillsUrl') return null
      throw new Error('denied')
    })
    renderPane()
    await ready()
    expect(widthOf()).toBe('300px')
  })

  it('works when localStorage cannot be written: resizing still resizes', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota') })
    renderPane()
    await ready()
    fireEvent.keyDown(separator(), { key: 'ArrowRight' })
    expect(widthOf()).toBe('316px')
    drag(316, 420)
    drop(420)
    expect(widthOf()).toBe('420px')
    fireEvent.doubleClick(separator())
    expect(widthOf()).toBe('300px')
  })
})

describe('a window too narrow to resize in', () => {
  it('has no handle and stays 300px whatever was stored', async () => {
    setWindow(1200)
    localStorage.setItem(STORAGE_KEY, '560')
    renderPane()
    await ready()
    expect(within(paneEl()).queryByRole('separator')).toBeNull()
    expect(widthOf()).toBe('300px')
  })

  it('loses its handle when the window shrinks to that size, and gets it back', async () => {
    renderPane()
    await ready()
    expect(separator()).toBeInTheDocument()
    setWindow(1200)
    expect(within(paneEl()).queryByRole('separator')).toBeNull()
    setWindow(1600)
    expect(separator()).toBeInTheDocument()
  })
})

describe('columns at width thresholds', () => {
  const widths: [number, string[]][] = [
    [300, []], [399, []], [400, ['status']], [479, ['status']], [480, ['status', 'year']],
    [559, ['status', 'year']], [560, ['status', 'year', 'lastAction']], [639, ['status', 'year', 'lastAction']],
    [640, ['status', 'year', 'lastAction', 'relevance']],
  ]
  it.each(widths)('at %ipx the headers are %j, in that order', async (w, cols) => {
    setWindow(1800)
    localStorage.setItem(STORAGE_KEY, String(w))
    renderPane()
    const pane = await ready()
    expect(colHeaders(pane)).toEqual(cols)
    expect(widthOf()).toBe(`${w}px`)
  })

  it('labels them Status, Year, Last action, Relevance', async () => {
    localStorage.setItem(STORAGE_KEY, '660')
    renderPane()
    const pane = await ready()
    const texts = Array.from(pane.querySelectorAll('[data-pane-col-header]')).map(e => e.textContent)
    expect(texts).toEqual(['Status', 'Year', 'Last action', 'Relevance'])
  })

  it('leaves priority and position out of the pane', async () => {
    localStorage.setItem(STORAGE_KEY, '660')
    renderPane()
    const pane = await ready()
    expect(within(pane).queryByText(/^position$/i)).toBeNull()
    expect(within(pane).queryByText(/^priority$/i)).toBeNull()
    expect(within(pane).queryByText(/member votes/i)).toBeNull()
  })

  it('widens a pane live: dragging across a threshold brings the column in', async () => {
    renderPane()
    const pane = await ready()
    expect(colHeaders(pane)).toEqual([])
    drag(300, 400)
    expect(colHeaders(pane)).toEqual(['status'])
    fireEvent.pointerMove(document, { clientX: 480, pointerId: 1 })
    expect(colHeaders(pane)).toEqual(['status', 'year'])
    fireEvent.pointerMove(document, { clientX: 399, pointerId: 1 })
    expect(colHeaders(pane)).toEqual([])
    drop(399)
  })

  it('shows the columns by keyboard too', async () => {
    renderPane()
    const pane = await ready()
    for (let i = 0; i < 7; i++) fireEvent.keyDown(separator(), { key: 'ArrowRight' }) // 300 + 112 = 412
    expect(colHeaders(pane)).toEqual(['status'])
  })

  it('puts the headers in a sticky block at the top of the scrolling list', async () => {
    localStorage.setItem(STORAGE_KEY, '420')
    renderPane()
    const pane = await ready()
    const header = pane.querySelector('[data-pane-columns]') as HTMLElement
    expect(header).not.toBeNull()
    expect(header.style.position).toBe('sticky')
    expect(header.style.top).toBe('0px')
    expect(header.closest('ul')).toBe(pane.querySelector('ul'))
    expect(header.style.background).toBeTruthy()
  })

  it('draws no header block while no column shows', async () => {
    renderPane()
    const pane = await ready()
    expect(pane.querySelector('[data-pane-columns]')).toBeNull()
  })

  it('draws no header block while loading, after an error, or with no bills', async () => {
    localStorage.setItem(STORAGE_KEY, '660')
    hoisted.respond = path => path.startsWith('/bills?') ? page([]) : {}
    renderPane()
    await screen.findByText(/No bills match/)
    expect(paneEl().querySelector('[data-pane-columns]')).toBeNull()
  })
})

describe('the row at a wide pane', () => {
  beforeEach(() => { localStorage.setItem(STORAGE_KEY, '660') })

  it('puts the status in the status column and draws it once', async () => {
    renderPane()
    const pane = await ready()
    const row = rowOf(pane, /Title of HB 1/)
    expect(cell(row, 'status')).toHaveTextContent('Passed')
    expect(within(row).getAllByText('Passed')).toHaveLength(1)
  })

  it('under 400px still puts the status chip at the top right, as today, with no columns', async () => {
    localStorage.setItem(STORAGE_KEY, '399')
    renderPane()
    const pane = await ready()
    const row = rowOf(pane, /Title of HB 1/)
    expect(cell(row, 'status')).toBeNull()
    expect(cell(row, 'year')).toBeNull()
    expect(within(row).getAllByText('Passed')).toHaveLength(1)
    const chipWrap = within(row).getByText('Passed').closest('span[style*="margin-left: auto"]')
    expect(chipWrap).not.toBeNull()
  })

  it('shows the year, with a range for a two-year session', async () => {
    renderPane()
    const pane = await ready()
    expect(cell(rowOf(pane, /Title of HB 1/), 'year')).toHaveTextContent('2025–26')
    expect(cell(rowOf(pane, /Title of HB 2/), 'year')).toBeEmptyDOMElement()
  })

  it('shows the last action date, or a dash', async () => {
    renderPane()
    const pane = await ready()
    expect(cell(rowOf(pane, /Title of HB 1/), 'lastAction')).toHaveTextContent('2026-03-04')
    expect(cell(rowOf(pane, /Title of HB 2/), 'lastAction')).toHaveTextContent('—')
  })

  it('shows the relevance score, and nothing when there is none', async () => {
    renderPane()
    const pane = await ready()
    expect(cell(rowOf(pane, /Title of HB 1/), 'relevance')).toHaveTextContent('7/10')
    expect(cell(rowOf(pane, /Title of HB 2/), 'relevance')).toBeEmptyDOMElement()
  })

  it('shows Draft in the status column for a draft', async () => {
    renderPane()
    const pane = await ready()
    expect(cell(rowOf(pane, /Title of HB 3/), 'status')).toHaveTextContent('Draft')
  })

  it('stacks a group row\'s statuses in the status column, one per distinct status', async () => {
    renderPane()
    const pane = await ready()
    const status = cell(rowOf(pane, /Title of S 5/), 'status')!
    expect(status).toHaveTextContent('Passed')
    expect(status).toHaveTextContent('Introduced')
    expect(status).not.toHaveTextContent('Referred') // behind "+1", as on the Bills page
  })

  it('keeps the bill number, with its priority square and "+N", ahead of the columns', async () => {
    renderPane()
    const pane = await ready()
    const row = rowOf(pane, /Title of HB 1/)
    expect(row).toHaveTextContent('high priority')
    const group = rowOf(pane, /Title of S 5/)
    expect(group).toHaveTextContent('+1')
    expect(group).toHaveTextContent('S 5')
    expect(group).toHaveTextContent('H 5')
  })

  it('wraps the title to two lines and no more', async () => {
    renderPane()
    const pane = await ready()
    const title = within(rowOf(pane, /Title of HB 1/)).getByText('Title of HB 1')
    expect(title.style.webkitLineClamp).toBe('2')
    expect(title.style.overflow).toBe('hidden')
  })

  it('lines the cells up under their headers: one grid template for the header and every row', async () => {
    renderPane()
    const pane = await ready()
    const header = pane.querySelector('[data-pane-columns]') as HTMLElement
    const grid = (el: Element) => (el.querySelector('[data-pane-grid]') as HTMLElement | null) ?? (el as HTMLElement)
    const template = grid(header).style.gridTemplateColumns
    expect(template).not.toBe('')
    for (const link of within(pane).getAllByRole('link', { name: /Title of/ })) {
      expect(grid(link).style.gridTemplateColumns).toBe(template)
    }
  })

  it('has as many grid tracks as columns showing, plus the bill number', async () => {
    localStorage.setItem(STORAGE_KEY, '500')
    renderPane()
    const pane = await ready()
    const header = pane.querySelector('[data-pane-columns]') as HTMLElement
    const tracks = (header.querySelector('[data-pane-grid]') as HTMLElement).style.gridTemplateColumns.trim().split(/\s+(?![^(]*\))/)
    expect(tracks).toHaveLength(1 + 2) // bill, status, year
  })

  it('gives a multi-state list the Bills page\'s wider bill-number track', async () => {
    hoisted.multi = true
    localStorage.setItem(STORAGE_KEY, '500')
    renderPane()
    const pane = await ready()
    const header = pane.querySelector('[data-pane-columns]') as HTMLElement
    expect((header.querySelector('[data-pane-grid]') as HTMLElement).style.gridTemplateColumns.startsWith('105px')).toBe(true)
  })

  it('keeps the row\'s padding the same at every width, so text does not move', async () => {
    renderPane()
    const wide = rowOf(await ready(), /Title of HB 1/).style.padding
    expect(wide).toBe('8px 12px 9px 15px')
    localStorage.setItem(STORAGE_KEY, '300')
    document.body.innerHTML = ''
    renderPane()
    expect(rowOf(await ready(), /Title of HB 1/).style.padding).toBe(wide)
  })

  it('still highlights the open row, and links to the bill', async () => {
    renderPane('/RI/2026/HB%201')
    const pane = await ready()
    const current = within(pane).getByRole('link', { current: 'page' })
    expect(current).toHaveTextContent('Title of HB 1')
    expect(current).toHaveAttribute('href', '/RI/2026/HB 1')
  })
})

describe('the cells are the Bills page\'s own components', () => {
  beforeEach(() => { localStorage.setItem(STORAGE_KEY, '660') })

  it('renders the year as a SessionChip, byte for byte', async () => {
    renderPane()
    const pane = await ready()
    const alone = render(<SessionChip session="2025–26" />)
    expect(cell(rowOf(pane, /Title of HB 1/), 'year')!.innerHTML).toBe(alone.container.innerHTML)
  })

  it('renders the relevance as a RelevanceChip, byte for byte', async () => {
    renderPane()
    const pane = await ready()
    const alone = render(<RelevanceChip score={7} />)
    expect(cell(rowOf(pane, /Title of HB 1/), 'relevance')!.innerHTML).toBe(alone.container.innerHTML)
  })

  it('renders the status as a StatusChip, byte for byte', async () => {
    renderPane()
    const pane = await ready()
    const alone = render(<StatusChip status={decodeStatus('Passed')} />)
    expect(cell(rowOf(pane, /Title of HB 1/), 'status')!.innerHTML).toBe(alone.container.innerHTML)
  })

  it('renders the last action as a LastActionChip, byte for byte', async () => {
    renderPane()
    const pane = await ready()
    const alone = render(<LastActionChip date="2026-03-04" />)
    expect(cell(rowOf(pane, /Title of HB 1/), 'lastAction')!.innerHTML).toBe(alone.container.innerHTML)
  })

  it('draws the cells as plain chips: the pane\'s rows are links, so none is a nested button', async () => {
    renderPane()
    const pane = await ready()
    const row = rowOf(pane, /Title of HB 1/)
    expect(within(row).queryAllByRole('button')).toHaveLength(0)
  })
})

describe('no layout shift when the summary row appears', () => {
  it('keeps the pane\'s width and the handle\'s place the same before and after the summary is drawn', async () => {
    localStorage.setItem(STORAGE_KEY, '520')
    renderPane()
    const pane = paneEl()
    const before = { width: pane.style.width, sep: separator().getAttribute('style'), valueNow: separator().getAttribute('aria-valuenow') }
    await ready()
    expect(pane.querySelector('[data-pane-summary]')).not.toBeNull()
    expect({ width: pane.style.width, sep: separator().getAttribute('style'), valueNow: separator().getAttribute('aria-valuenow') }).toEqual(before)
  })

  it('anchors the sticky headers at the top of the list, so the summary above it cannot push them', async () => {
    localStorage.setItem(STORAGE_KEY, '520')
    renderPane()
    const pane = await ready()
    expect(pane.querySelector('[data-pane-summary]')).not.toBeNull()
    expect((pane.querySelector('[data-pane-columns]') as HTMLElement).style.top).toBe('0px')
    expect(pane.querySelector('[data-pane-summary]')!.closest('ul')).toBeNull()
  })

  it('keeps the summary and its Edit link clear of the handle', async () => {
    localStorage.setItem(STORAGE_KEY, '520')
    renderPane()
    const pane = await ready()
    const summary = pane.querySelector('[data-pane-summary]') as HTMLElement
    expect(summary.style.padding).toBe('0px 12px 10px 15px')
    expect(within(summary).getByRole('link', { name: 'Edit' })).toBeInTheDocument()
  })

  it('draws the same width whether the list loaded, failed, or came back empty', async () => {
    localStorage.setItem(STORAGE_KEY, '520')
    hoisted.respond = () => new Error('boom')
    renderPane()
    await screen.findByText('Couldn’t load bills.')
    expect(widthOf()).toBe('520px')
  })
})
