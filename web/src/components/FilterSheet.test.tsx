import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { render, screen, within, fireEvent } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { FilterSheet } from './FilterSheet'
import type { SubjectGroup } from '../pages/BillList/FilterPanel'

function makeDefaults(): ComponentProps<typeof FilterSheet> {
  return {
    isOpen: true,
    onClose: vi.fn(),
    statuses: [],
    priorities: [],
    positions: [],
    tags: [],
    subjects: [],
    sessions: [],
    minRelevance: 0,
    myBills: false,
    statusOptions: [{ value: 'active', label: 'Active' }, { value: 'dead', label: 'Dead' }],
    priorityOptions: [{ value: 'high', label: 'High' }],
    positionOptions: [{ value: 'support', label: 'Support' }],
    tagOptions: ['Education', 'Health Care'],
    subjectGroups: [{ state: 'UT', options: [{ value: 'UT:Counties', label: 'Counties', count: 2 }] }],
    statesWithoutSubjects: [],
    sessionOptions: [{ value: '2026', label: '2026 Session' }],
    totalSessionCount: 1,
    onStatusChange: vi.fn(),
    onPriorityChange: vi.fn(),
    onPositionChange: vi.fn(),
    onTagChange: vi.fn(),
    onSubjectChange: vi.fn(),
    onSessionChange: vi.fn(),
    onMinRelevanceChange: vi.fn(),
    onMyBillsChange: vi.fn(),
    onClearAll: vi.fn(),
  }
}

function renderSheet(overrides: Partial<ComponentProps<typeof FilterSheet>> = {}) {
  return render(<FilterSheet {...makeDefaults()} {...overrides} />)
}

function makeSubjectGroups(spec: Record<string, number>): SubjectGroup[] {
  return Object.entries(spec).map(([state, count]) => ({
    state,
    options: Array.from({ length: count }, (_, i) => ({
      value: `${state}:Subject ${i}`,
      label: `Subject ${i}`,
      count: count - i,
    })),
  }))
}

function makeTagOptions(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `Tag ${i}`)
}

// FilterSheetVirtualList (Subjects, Tags) is virtualized (@tanstack/react-virtual).
// jsdom performs no layout, so the scroll container's real offsetHeight is 0 and
// the virtualizer would compute a 0-row viewport and render nothing. Stub
// offsetHeight on HTMLElement.prototype to a realistic pixel value, same
// technique as FilterPanel.test.tsx (and TanStack Virtual's own jsdom tests),
// rather than mocking the virtualizer away — that would make it impossible to
// assert that a 2000-option panel renders only a handful of row nodes.
let restoreOffsetHeight: (() => void) | undefined
beforeAll(() => {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, value: 600 })
  restoreOffsetHeight = () => {
    if (descriptor) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', descriptor)
  }
})
afterAll(() => { restoreOffsetHeight?.() })

describe('FilterSheet — dimension list (level 1)', () => {
  it('opens on the dimension list, not on any dimension\'s options', () => {
    renderSheet()
    expect(screen.getByText('Filter Bills')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /status/i })).toBeInTheDocument()
    // No option chips or checkboxes from any dimension are mounted yet.
    expect(screen.queryByText('Active')).not.toBeInTheDocument()
    expect(screen.queryByText('Counties')).not.toBeInTheDocument()
  })

  it('shows a dimension row for each rendered dimension', () => {
    renderSheet()
    for (const name of [/status/i, /priority/i, /position/i, /session/i, /topics/i, /subject/i]) {
      expect(screen.getByRole('button', { name })).toBeInTheDocument()
    }
  })

  it('omits a dimension row when that dimension has no options', () => {
    renderSheet({ tagOptions: [], subjectGroups: [] })
    expect(screen.queryByRole('button', { name: /topics/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /subject/i })).not.toBeInTheDocument()
  })

  it('a dimension row shows the count of currently-selected options within it', () => {
    renderSheet({ statuses: ['active', 'dead'], priorities: [] })
    const statusRow = screen.getByRole('button', { name: /status/i })
    expect(within(statusRow).getByText('2')).toBeInTheDocument()
    const priorityRow = screen.getByRole('button', { name: /priority/i })
    expect(within(priorityRow).queryByText('0')).not.toBeInTheDocument()
  })

  it('keeps My Bills and Min. Relevance as direct controls on the dimension list, not drill-down rows', () => {
    renderSheet()
    expect(screen.getByText('My voted bills')).toBeInTheDocument()
    expect(screen.getByText('Min. Relevance')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /my bills/i })).not.toBeInTheDocument()
  })
})

describe('FilterSheet — drilling into a dimension', () => {
  it('tapping a dimension shows its options, and the back affordance returns to the dimension list', () => {
    renderSheet()
    fireEvent.click(screen.getByRole('button', { name: /status/i }))
    expect(screen.getByText('Active')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /priority/i })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /back to filters/i }))
    expect(screen.queryByText('Active')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /status/i })).toBeInTheDocument()
  })

  it('selecting an option inside a dimension propagates through the existing change callback', () => {
    const onStatusChange = vi.fn()
    renderSheet({ onStatusChange })
    fireEvent.click(screen.getByRole('button', { name: /status/i }))
    fireEvent.click(screen.getByText('Active'))
    expect(onStatusChange).toHaveBeenCalledWith(['active'])
  })

  it('resets to the dimension list whenever the sheet re-opens', () => {
    const { rerender } = renderSheet({ isOpen: true })
    fireEvent.click(screen.getByRole('button', { name: /status/i }))
    expect(screen.getByText('Active')).toBeInTheDocument()

    rerender(<FilterSheet {...makeDefaults()} isOpen={false} />)
    rerender(<FilterSheet {...makeDefaults()} isOpen={true} />)
    expect(screen.queryByText('Active')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /status/i })).toBeInTheDocument()
  })

  it('clear all keeps working while drilled into a dimension', () => {
    const onClearAll = vi.fn()
    renderSheet({ statuses: ['active'], onClearAll })
    fireEvent.click(screen.getByRole('button', { name: /status/i }))
    fireEvent.click(screen.getByText('Clear all'))
    expect(onClearAll).toHaveBeenCalled()
  })
})

describe('FilterSheet — Subjects', () => {
  it('renders state headings for multiple states and omits them for one', () => {
    const { rerender } = renderSheet({
      subjectGroups: [
        { state: 'NJ', options: [{ value: 'NJ:Education', label: 'Education', count: 4 }] },
        { state: 'UT', options: [{ value: 'UT:Counties', label: 'Counties', count: 2 }] },
      ],
    })
    fireEvent.click(screen.getByRole('button', { name: /subject/i }))
    expect(screen.getByText('NJ')).toBeInTheDocument()
    expect(screen.getByText('UT')).toBeInTheDocument()

    rerender(<FilterSheet {...makeDefaults()} subjectGroups={[{ state: 'UT', options: [{ value: 'UT:Counties', label: 'Counties', count: 2 }] }]} />)
    expect(screen.queryByText('UT')).not.toBeInTheDocument()
    expect(screen.getByText('Counties')).toBeInTheDocument()
  })

  it('shows the statesWithoutSubjects notice only when a subject is selected and some states publish none', () => {
    const { rerender } = renderSheet({ subjects: [], statesWithoutSubjects: ['CA', 'IL'] })
    fireEvent.click(screen.getByRole('button', { name: /subject/i }))
    expect(screen.queryByText(/do not publish subjects/)).not.toBeInTheDocument()

    rerender(<FilterSheet {...makeDefaults()} subjects={['UT:Counties']} statesWithoutSubjects={[]} />)
    expect(screen.queryByText(/do not publish subjects/)).not.toBeInTheDocument()

    rerender(<FilterSheet {...makeDefaults()} subjects={['UT:Counties']} statesWithoutSubjects={['CA', 'IL']} />)
    expect(screen.getByText(/CA, IL/)).toBeInTheDocument()
    expect(screen.getByText(/do not publish subjects/)).toBeInTheDocument()
  })
})

describe('FilterSheet — long dimensions (virtualized + search)', () => {
  it('mounts only a small subset of option nodes for a large Subjects dimension', () => {
    renderSheet({ subjectGroups: makeSubjectGroups({ CA: 1000, TX: 1000 }) })
    fireEvent.click(screen.getByRole('button', { name: /subject/i }))
    const checkboxes = screen.getAllByRole('checkbox')
    expect(checkboxes.length).toBeGreaterThan(0)
    expect(checkboxes.length).toBeLessThan(100)
  })

  it('mounts only a small subset of option nodes for a large Tags dimension', () => {
    renderSheet({ tagOptions: makeTagOptions(2000) })
    fireEvent.click(screen.getByRole('button', { name: /topics/i }))
    const checkboxes = screen.getAllByRole('checkbox')
    expect(checkboxes.length).toBeGreaterThan(0)
    expect(checkboxes.length).toBeLessThan(100)
  })

  it('narrows Subjects options by search, case-insensitively', () => {
    renderSheet({
      subjectGroups: [{
        state: 'UT',
        options: [
          { value: 'UT:Counties', label: 'Counties', count: 2 },
          { value: 'UT:Education', label: 'Education', count: 5 },
        ],
      }],
    })
    fireEvent.click(screen.getByRole('button', { name: /subject/i }))
    fireEvent.change(screen.getByPlaceholderText(/search subjects/i), { target: { value: 'COUN' } })
    expect(screen.getByText('Counties')).toBeInTheDocument()
    expect(screen.queryByText('Education')).not.toBeInTheDocument()
  })

  it('narrows Tags options by search, case-insensitively', () => {
    renderSheet({ tagOptions: ['Education', 'Health Care', 'Transportation'] })
    fireEvent.click(screen.getByRole('button', { name: /topics/i }))
    fireEvent.change(screen.getByPlaceholderText(/search topics/i), { target: { value: 'health' } })
    expect(screen.getByText('Health Care')).toBeInTheDocument()
    expect(screen.queryByText('Education')).not.toBeInTheDocument()
  })

  it('propagates a Tags selection through the existing change callback', () => {
    const onTagChange = vi.fn()
    renderSheet({ tagOptions: ['Education', 'Health Care'], onTagChange })
    fireEvent.click(screen.getByRole('button', { name: /topics/i }))
    fireEvent.click(screen.getByText('Education'))
    expect(onTagChange).toHaveBeenCalledWith(['Education'])
  })
})
