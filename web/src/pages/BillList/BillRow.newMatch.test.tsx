import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { BillRow } from './BillRow'
import type { Bill } from './types'
import { expectAmber, expectNotAmber } from '../../test/amberStyle'
import { PRIORITY_COLORS } from '../../lib/chipStyles'

const apiFetchMock = vi.fn()
vi.mock('../../lib/api', () => ({ apiFetch: (...args: unknown[]) => apiFetchMock(...args) }))

vi.mock('../../context/ConfigContext', () => ({
  useConfig: () => ({ config: null, multiState: false, loading: false }),
  useMultiState: () => false,
}))
vi.mock('../../context/DemoContext', () => ({
  useDemo: () => ({ demoMode: false, demoLocked: false }),
}))

const NEW_MATCH: Partial<Bill> = { matchType: 'keyword', newMatchAt: '2026-02-02 09:00:00', triagedAt: null, priority: null }

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

function renderRow(isAdmin: boolean, bill: Partial<Bill> = {}) {
  const onPriorityChange = vi.fn()
  const onTriageDismiss = vi.fn()
  const onPriorityClick = vi.fn()
  const utils = render(
    <MemoryRouter>
      <BillRow
        bill={makeBill(bill)}
        index={0}
        onTagClick={vi.fn()}
        isAdmin={isAdmin}
        positionVocabulary={['Support', 'Oppose']}
        onStatusClick={vi.fn()}
        onPriorityClick={onPriorityClick}
        onPositionClick={vi.fn()}
        onRelevanceClick={vi.fn()}
        onPriorityChange={onPriorityChange}
        onPositionChange={vi.fn()}
        onTriageDismiss={onTriageDismiss}
        onVote={undefined}
        filter={{ status: [], priority: [], position: [], year: [], minRelevance: 0, tag: [] }}
        sortedPaths={[]}
        isMultiState={false}
        isSelectionMode={false}
        isSelected={false}
        onToggleSelect={isAdmin ? vi.fn() : undefined}
      />
    </MemoryRouter>,
  )
  return { ...utils, onPriorityChange, onTriageDismiss, onPriorityClick }
}

// Priority renders twice, in the desktop column and in the mobile meta line;
// CSS picks which one shows, so both are in the DOM.
const prioritySelects = () => screen.getAllByRole('combobox', { name: /priority/i })
const optionLabels = (select: HTMLElement) => within(select).getAllByRole('option').map(o => o.textContent)

beforeEach(() => apiFetchMock.mockReset())

describe('BillRow: an admin sees a new match as an amber state of the priority dropdown', () => {
  it('shows the amber "New · Set priority" dropdown in both priority slots', () => {
    renderRow(true, NEW_MATCH)
    const selects = prioritySelects()
    expect(selects).toHaveLength(2)
    for (const s of selects) {
      expect(s).toHaveDisplayValue('New · Set priority')
      expectAmber(s)
    }
  })

  it('has no separate Dismiss button: Dismiss is the last option of the dropdown', () => {
    renderRow(true, NEW_MATCH)
    expect(screen.queryByRole('button', { name: /dismiss/i })).toBeNull()
    for (const s of prioritySelects()) {
      expect(optionLabels(s)).toEqual(['New · Set priority', 'High Priority', 'Medium Priority', 'Low Priority', 'Dismiss (reviewed, no priority)'])
    }
  })

  it('choosing a priority PATCHes it and reports the change', async () => {
    apiFetchMock.mockResolvedValue({ priority: 'high' })
    const { onPriorityChange, onTriageDismiss } = renderRow(true, NEW_MATCH)
    fireEvent.change(prioritySelects()[0], { target: { value: 'high' } })
    await waitFor(() => expect(onPriorityChange).toHaveBeenCalledWith('b1', 'high'))
    expect(apiFetchMock).toHaveBeenCalledWith('/bills/b1/priority', { method: 'PATCH', body: JSON.stringify({ priority: 'high' }) })
    expect(onTriageDismiss).not.toHaveBeenCalled()
  })

  it('choosing Dismiss calls triage-dismiss and reports it, without setting a priority', async () => {
    apiFetchMock.mockResolvedValue({ ok: true })
    const { onPriorityChange, onTriageDismiss } = renderRow(true, NEW_MATCH)
    fireEvent.change(prioritySelects()[0], { target: { value: 'dismiss' } })
    await waitFor(() => expect(onTriageDismiss).toHaveBeenCalledWith('b1'))
    expect(apiFetchMock).toHaveBeenCalledTimes(1)
    expect(apiFetchMock).toHaveBeenCalledWith('/bills/b1/triage-dismiss', { method: 'PATCH' })
    expect(onPriorityChange).not.toHaveBeenCalled()
  })

  it('names the new match in its tooltip text', () => {
    renderRow(true, NEW_MATCH)
    expect(prioritySelects()[0]).toHaveAccessibleName(/new match/i)
  })

  it.each([
    ['a priority is already set', { priority: 'low' as const }],
    ['it was dismissed', { triagedAt: '2026-02-03 10:00:00' }],
    ['it is a manual add, not a keyword match', { matchType: 'manual' as const }],
    ['it has no new-match stamp', { newMatchAt: null }],
  ])('is not amber and offers no Dismiss when %s', (_why, over) => {
    renderRow(true, { ...NEW_MATCH, ...over })
    for (const s of prioritySelects()) {
      expectNotAmber(s)
      expect(optionLabels(s)).not.toContain('Dismiss (reviewed, no priority)')
      expect(optionLabels(s)[0]).toBe('Set priority')
    }
  })
})

describe('BillRow: a bill that is not a new match', () => {
  it('shows an empty priority as a plain "Set priority" dropdown for an admin', () => {
    renderRow(true, { matchType: 'manual' })
    for (const s of prioritySelects()) {
      expect(s).toHaveDisplayValue('Set priority')
      expect(optionLabels(s)).toEqual(['Set priority', 'High Priority', 'Medium Priority', 'Low Priority'])
    }
  })

  it('shows a set priority for an admin unchanged', () => {
    renderRow(true, { priority: 'high', matchType: 'manual' })
    expect(prioritySelects()[0]).toHaveDisplayValue('High Priority')
  })

  it('shows a member the priority badge, as before', () => {
    renderRow(false, { priority: 'high', matchType: 'manual' })
    expect(screen.queryByRole('combobox', { name: /priority/i })).toBeNull()
    expect(screen.getAllByText(PRIORITY_COLORS.high.label).length).toBeGreaterThan(0)
    expect(screen.queryByText('New match')).toBeNull()
  })

  it('shows a member with no priority and no new match a dash in the column, as before', () => {
    renderRow(false, { matchType: 'manual' })
    expect(screen.queryByText('New match')).toBeNull()
    expect(screen.queryByRole('combobox', { name: /priority/i })).toBeNull()
  })
})

describe('BillRow: a member sees the amber state, read-only', () => {
  it('shows the amber "New match" state where an admin has the dropdown', () => {
    renderRow(false, NEW_MATCH)
    const chips = screen.getAllByText('New match')
    expect(chips.length).toBeGreaterThan(0)
    for (const chip of chips) {
      expectAmber(chip)
    }
  })

  it('has no dropdown, no Dismiss, and nothing to click or focus in that state', () => {
    renderRow(false, NEW_MATCH)
    expect(screen.getAllByText('New match').length).toBeGreaterThan(0)
    expect(screen.queryByRole('combobox')).toBeNull()
    expect(screen.queryByRole('button', { name: /dismiss|priority|new match/i })).toBeNull()
    expect(screen.queryByText('Dismiss (reviewed, no priority)')).toBeNull()
  })

  it('clicking the chip filters nothing', () => {
    const { onPriorityClick, onTriageDismiss } = renderRow(false, NEW_MATCH)
    fireEvent.click(screen.getAllByText('New match')[0])
    expect(onPriorityClick).not.toHaveBeenCalled()
    expect(onTriageDismiss).not.toHaveBeenCalled()
    expect(apiFetchMock).not.toHaveBeenCalled()
  })

  it('drops the amber state once the match is triaged', () => {
    renderRow(false, { ...NEW_MATCH, triagedAt: '2026-02-03 10:00:00' })
    expect(screen.queryByText('New match')).toBeNull()
  })

  it('shows the priority, not the amber state, once one is set', () => {
    renderRow(false, { ...NEW_MATCH, priority: 'medium' })
    expect(screen.queryByText('New match')).toBeNull()
    expect(screen.getAllByText(PRIORITY_COLORS.medium.label).length).toBeGreaterThan(0)
  })
})
