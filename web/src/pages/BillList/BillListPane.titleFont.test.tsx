import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { BillRow } from './BillRow'
import { BILL_TITLE_TEXT } from '../../lib/textStyles'
import type { Bill } from './types'

// Bill titles in the split pane use the Bills table's family and weight (#683).

const hoisted = vi.hoisted(() => ({ bills: [] as unknown[] }))
vi.mock('../../lib/api', () => ({
  apiFetch: async (path: string) => path.startsWith('/bills?')
    ? { bills: hoisted.bills, pagination: { page: 1, pageSize: 100, total: hoisted.bills.length, totalPages: 1 } }
    : {},
  ApiError: class ApiError extends Error {},
}))
vi.mock('../../context/ConfigContext', () => ({
  useConfig: () => ({ config: null, multiState: false, loading: false }),
  useMultiState: () => false,
}))
vi.mock('../../context/DemoContext', () => ({
  useDemo: () => ({ demoMode: false, demoLocked: false }),
}))
vi.mock('./index', () => ({
  peekBillsListCache: () => null,
  peekCustomFieldDefs: () => [],
}))

import { BillListPane } from './BillListPane'

function bill(over: Partial<Bill> = {}): Bill {
  return {
    id: 'b1', billNumber: 'HB 1', title: 'A bill about roads', state: 'RI', status: 'Introduced',
    session: '2026', sessionSlug: '2026', sessionId: null, yearStart: 2026, yearEnd: 2026,
    abstract: null, url: null, stateUrl: null, lastAction: null, lastActionDate: null, tenantSummary: null,
    tags: [], priority: null, matchType: null, isDraft: false, position: null, relevanceScore: null,
    aiProcessedAt: null, newMatchAt: null, triagedAt: null,
    voteCounts: { support: 0, oppose: 0, neutral: 0 }, myVote: null,
    commentCount: 0, hasNote: false, hasComment: false, updatedAt: '2026-01-01 00:00:00',
    customFieldValues: {}, ...over,
  }
}

const realInnerWidth = window.innerWidth
beforeEach(() => {
  sessionStorage.clear()
  localStorage.clear()
  Element.prototype.scrollIntoView = vi.fn()
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 1600 })
})
afterEach(() => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: realInnerWidth })
})

async function paneTitle(text: string) {
  render(<MemoryRouter initialEntries={['/RI/2026/HB%201']}><BillListPane /></MemoryRouter>)
  const pane = await screen.findByRole('navigation', { name: 'Bill list' })
  return await within(pane).findByText(text)
}

function tableTitle(text: string) {
  render(
    <MemoryRouter>
      <BillRow
        bill={bill({ title: text })} index={0} selectedTags={[]} onTagClick={vi.fn()} isAdmin={false}
        positionVocabulary={[]} onStatusClick={vi.fn()} onPriorityClick={vi.fn()} onPositionClick={vi.fn()}
        onRelevanceClick={vi.fn()} onPriorityChange={vi.fn()} onPositionChange={vi.fn()} onVote={undefined}
        filterStatuses={[]} filterPriorities={[]} filterPositions={[]} filterYears={[]} filterMinRelevance={0}
        sortedPaths={[]} isMultiState={false} isSelectionMode={false} isSelected={false} onToggleSelect={undefined}
      />
    </MemoryRouter>,
  )
  return screen.getAllByText(text)[0]
}

describe('bill titles in the pane', () => {
  it('use the same font family and weight as the Bills table\'s titles', async () => {
    hoisted.bills = [bill()]
    const inPane = getComputedStyle(await paneTitle('A bill about roads'))
    const inTable = getComputedStyle(tableTitle('A bill about roads'))
    expect(inPane.fontFamily).toBe(inTable.fontFamily)
    expect(inPane.fontWeight).toBe(inTable.fontWeight)
    expect(inPane.fontFamily).toContain('Source Serif 4')
    expect(String(inPane.fontWeight)).toBe('700')
  })

  it('take their family and weight from the shared title style', async () => {
    hoisted.bills = [bill()]
    const inPane = getComputedStyle(await paneTitle('A bill about roads'))
    expect(inPane.fontFamily.replace(/["']/g, "")).toBe(String(BILL_TITLE_TEXT.fontFamily).replace(/["']/g, ""))
    expect(String(inPane.fontWeight)).toBe(String(BILL_TITLE_TEXT.fontWeight))
  })

  it('are no larger than the Bills table\'s titles (a smaller size is fine)', async () => {
    hoisted.bills = [bill()]
    const inPane = parseFloat(getComputedStyle(await paneTitle('A bill about roads')).fontSize)
    const inTable = parseFloat(getComputedStyle(tableTitle('A bill about roads')).fontSize)
    expect(inPane).toBeLessThanOrEqual(inTable)
  })

  it('match the table in the same family and weight at a wide pane, too', async () => {
    localStorage.setItem('billListPaneWidth', '660')
    hoisted.bills = [bill()]
    const inPane = getComputedStyle(await paneTitle('A bill about roads'))
    expect(inPane.fontFamily).toContain('Source Serif 4')
    expect(String(inPane.fontWeight)).toBe('700')
  })

  it('keep the two-line clamp', async () => {
    hoisted.bills = [bill()]
    const title = await paneTitle('A bill about roads')
    expect((title.style as unknown as Record<string, string>).WebkitLineClamp).toBe('2')
  })

  it('keep the same family for a draft with no title ("Untitled draft")', async () => {
    hoisted.bills = [bill({ title: '', isDraft: true, matchType: 'manual', billNumber: 'D1' })]
    const inPane = getComputedStyle(await paneTitle('Untitled draft'))
    expect(inPane.fontFamily).toContain('Source Serif 4')
  })
})
