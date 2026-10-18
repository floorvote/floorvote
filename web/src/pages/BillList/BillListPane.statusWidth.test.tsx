import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, within, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { Bill, GroupMember } from './types'
import { LONGEST_STATUS_LABELS, VERY_LONG_STATUS } from '../../components/longStatusLabels.fixture'

// A long provider status in the split pane (#404): capped in the status column
// when the pane is wide enough for columns, and capped at the top right when it
// is not. The pane is rendered on its own, as in BillListPane.resize.test.tsx.

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

const LONG = bill('b1', 'HB 1', { status: VERY_LONG_STATUS })
const SHORT = bill('b2', 'HB 2', { status: 'Passed' })
const DRAFT = bill('b3', 'HB 3', { isDraft: true, status: 'Draft' })
const GROUP = bill('g1', 'S 5', {
  status: 'Passed',
  group: [member('g1', 'S 5', VERY_LONG_STATUS), member('g2', 'H 5', 'Passed'), member('g3', 'H 6', 'Introduced')],
})
const VOCAB = LONGEST_STATUS_LABELS.map((v, i) => bill(`v${i}`, `VB ${i}`, { status: v.status }))

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
const cell = (row: HTMLElement, col: string) => row.querySelector(`[data-pane-col="${col}"]`) as HTMLElement | null

beforeEach(() => {
  hoisted.respond = (path) => path.startsWith('/bills?') ? page([LONG, SHORT, DRAFT, GROUP, ...VOCAB]) : {}
  sessionStorage.clear()
  localStorage.clear()
  Element.prototype.scrollIntoView = vi.fn()
  setWindow(1600)
})
afterEach(() => {
  vi.restoreAllMocks()
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: realInnerWidth })
})

describe.each([
  ['the status column (a wide pane)', '660', (row: HTMLElement) => cell(row, 'status')!],
  ['the top right of the row (a narrow pane)', '300', (row: HTMLElement) => row],
])('a long status in %s', (_name, width, scope) => {
  beforeEach(() => { localStorage.setItem(STORAGE_KEY, width) })

  it('is capped at 100px, ends in an ellipsis, and has the full label as hover text', async () => {
    const pane = await ready()
    const chip = within(scope(rowOf(pane, /Title of HB 1/))).getByText(VERY_LONG_STATUS)
    expect(chip.style.maxWidth).toBe('100px')
    expect(chip.style.overflow).toBe('hidden')
    expect(chip.style.textOverflow).toBe('ellipsis')
    expect(chip).toHaveAttribute('title', VERY_LONG_STATUS)
  })

  it('is drawn once, with the full label still in the markup', async () => {
    const pane = await ready()
    const row = rowOf(pane, /Title of HB 1/)
    expect(within(row).getAllByText(VERY_LONG_STATUS)).toHaveLength(1)
  })

  it.each(LONGEST_STATUS_LABELS)('caps the longest $provider label and keeps its full name', async ({ label }) => {
    const pane = await ready()
    const index = LONGEST_STATUS_LABELS.findIndex(v => v.label === label)
    const chip = within(scope(rowOf(pane, new RegExp(`Title of VB ${index}$`)))).getByText(label)
    expect(chip.style.maxWidth).toBe('100px')
    expect(chip.style.textOverflow).toBe('ellipsis')
    expect(chip).toHaveAttribute('title', label)
  })

  it('leaves a short label as it was', async () => {
    const pane = await ready()
    const chip = within(scope(rowOf(pane, /Title of HB 2/))).getByText('Passed')
    expect(chip.textContent).toBe('Passed')
    expect(chip.style.width).toBe('')
  })

  it('caps each of a group\'s stacked statuses, each with its own full label', async () => {
    const pane = await ready()
    const row = scope(rowOf(pane, /Title of S 5/))
    const long = within(row).getByText(VERY_LONG_STATUS)
    const short = within(row).getByText('Passed')
    expect(long.style.maxWidth).toBe('100px')
    expect(long).toHaveAttribute('title', VERY_LONG_STATUS)
    expect(short.style.maxWidth).toBe('100px')
    expect(short).toHaveAttribute('title', 'Passed')
  })

  it('leaves the draft chip alone', async () => {
    const pane = await ready()
    const chip = within(scope(rowOf(pane, /Title of HB 3/))).getByText('Draft')
    expect(chip.style.maxWidth).toBe('')
    expect(chip).not.toHaveAttribute('title')
  })

  it('is not a button: the pane filters nothing', async () => {
    const pane = await ready()
    expect(within(rowOf(pane, /Title of HB 1/)).queryByRole('button')).toBeNull()
  })
})

describe('the status column\'s track', () => {
  it('is as wide as the cap, so a capped chip fits its column', async () => {
    localStorage.setItem(STORAGE_KEY, '660')
    const pane = await ready()
    const grid = rowOf(pane, /Title of HB 1/).querySelector('[data-pane-grid]') as HTMLElement
    expect(grid.style.gridTemplateColumns.split(' ')[1]).toBe('100px')
  })

  it('lets the cell shrink to its track rather than push the next column', async () => {
    localStorage.setItem(STORAGE_KEY, '660')
    const pane = await ready()
    expect(cell(rowOf(pane, /Title of HB 1/), 'status')!.style.minWidth).toBe('0px')
  })
})
