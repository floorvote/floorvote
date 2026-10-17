import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, fireEvent, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { BillRow } from './BillRow'
import type { Bill, GroupMember } from './types'
import { LONGEST_STATUS_LABELS, VERY_LONG_STATUS } from '../../components/longStatusLabels.fixture'

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom')
  return { ...actual, useNavigate: () => vi.fn() }
})
vi.mock('../../context/ConfigContext', () => ({
  useConfig: () => ({ config: null, multiState: false, loading: false }),
  useMultiState: () => false,
}))
vi.mock('../../context/DemoContext', () => ({
  useDemo: () => ({ demoMode: false, demoLocked: false }),
}))

// A long provider status in the bill table (#404): the status cell on a desktop
// row and the status in the phone row's meta line both cap the chip. The CSS
// that shows one or the other is not run in jsdom, so both are in the markup.

const member = (id: string, billNumber: string, status: string): GroupMember =>
  ({ id, billNumber, state: 'RI', status, sessionSlug: '2026' })

function makeBill(over: Partial<Bill> = {}): Bill {
  return {
    id: 'b1', billNumber: 'HB 1', title: 'Test bill', state: 'RI', status: 'Introduced',
    session: '2026', sessionSlug: '2026', sessionId: null, yearStart: 2026, yearEnd: 2026,
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

function renderRow(bill: Partial<Bill>, props: { onStatusClick?: (s: string) => void; filterStatuses?: string[] } = {}) {
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
        onVote={vi.fn()}
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

const tableStatus = (c: HTMLElement) => c.querySelector('.bill-col-status') as HTMLElement
const phoneMeta = (c: HTMLElement) => c.querySelector('.bill-row-mobile-meta') as HTMLElement

// The chip text node's element: the span holding the label.
const chipIn = (scope: HTMLElement, text: string) => within(scope).getByText(text)

afterEach(() => vi.restoreAllMocks())

describe.each([
  ['the bill table', tableStatus],
  ['the phone row', phoneMeta],
])('a long status in %s', (_name, scope) => {
  it('is capped at 100px, ends in an ellipsis, and has the full label as hover text', () => {
    const { container } = renderRow({ status: VERY_LONG_STATUS })
    const chip = chipIn(scope(container), VERY_LONG_STATUS)
    expect(chip.style.maxWidth).toBe('100px')
    expect(chip.style.overflow).toBe('hidden')
    expect(chip.style.textOverflow).toBe('ellipsis')
    expect(chip).toHaveAttribute('title', VERY_LONG_STATUS)
  })

  it.each(LONGEST_STATUS_LABELS)('caps the longest $provider label and keeps its full name', ({ status, label }) => {
    const { container } = renderRow({ status })
    const chip = chipIn(scope(container), label)
    expect(chip.style.maxWidth).toBe('100px')
    expect(chip.style.textOverflow).toBe('ellipsis')
    expect(chip).toHaveAttribute('title', label)
    expect(scope(container)).toHaveTextContent(label)
  })

  it('leaves a short label as it was: full text, no cut', () => {
    const { container } = renderRow({ status: 'Passed' })
    const chip = chipIn(scope(container), 'Passed')
    expect(chip.textContent).toBe('Passed')
    expect(chip.style.width).toBe('')
  })

  it('draws a group\'s stacked statuses each capped, each with its own full label', () => {
    const { container } = renderRow({
      status: 'Passed',
      group: [member('b1', 'HB 1', 'Passed'), member('b2', 'SB 1', VERY_LONG_STATUS)],
    })
    const long = chipIn(scope(container), VERY_LONG_STATUS)
    const short = chipIn(scope(container), 'Passed')
    expect(long.style.maxWidth).toBe('100px')
    expect(long).toHaveAttribute('title', VERY_LONG_STATUS)
    expect(short.style.maxWidth).toBe('100px')
    expect(short).toHaveAttribute('title', 'Passed')
  })

  it('leaves the draft chip alone', () => {
    const { container } = renderRow({ isDraft: true, status: '' })
    const chip = chipIn(scope(container), 'Draft')
    expect(chip.style.maxWidth).toBe('')
    expect(chip).not.toHaveAttribute('title')
  })
})

describe('the bill table\'s status filter', () => {
  it('still filters by the long status\'s own value when its chip is clicked', () => {
    const onStatusClick = vi.fn()
    const { container } = renderRow({ status: VERY_LONG_STATUS }, { onStatusClick })
    fireEvent.click(chipIn(tableStatus(container), VERY_LONG_STATUS))
    expect(onStatusClick).toHaveBeenCalledWith(VERY_LONG_STATUS)
  })

  it('names the button by the full label', () => {
    const { container } = renderRow({ status: VERY_LONG_STATUS })
    expect(within(tableStatus(container)).getByRole('button', { name: VERY_LONG_STATUS })).toHaveAttribute('title', VERY_LONG_STATUS)
  })

  it('marks a capped chip active when the filter names its status', () => {
    const { container } = renderRow({ status: VERY_LONG_STATUS }, { filterStatuses: [VERY_LONG_STATUS] })
    expect(chipIn(tableStatus(container), VERY_LONG_STATUS).style.outline).toContain('solid')
  })

  it('decodes a bare LegiScan code, then caps the word it names', () => {
    const { container } = renderRow({ status: '10' })
    const chip = chipIn(tableStatus(container), 'Report Pass')
    expect(chip.style.maxWidth).toBe('100px')
  })
})

describe('the phone row\'s status', () => {
  it('is not a filter button', () => {
    const { container } = renderRow({ status: VERY_LONG_STATUS })
    expect(within(phoneMeta(container)).queryByRole('button', { name: VERY_LONG_STATUS })).toBeNull()
  })
})
