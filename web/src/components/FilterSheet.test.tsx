import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { render, screen, within, fireEvent } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { FilterSheet } from './FilterSheet'
import type { SubjectGroup } from '../pages/BillList/FilterPanel'
import type { CustomFieldDef } from '../pages/BillList/types'

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
    states: [],
    minRelevance: 0,
    myBills: false,
    isAdmin: false,
    newMatches: false,
    newMatchesCount: 0,
    unvotedOnly: false,
    matchAny: false,
    onMatchAnyChange: vi.fn(),
    uniqueStates: ['UT'],
    isMultiState: false,
    statusOptions: [{ value: 'active', label: 'Active' }, { value: 'dead', label: 'Dead' }],
    priorityOptions: [{ value: 'high', label: 'High' }],
    positionOptions: [{ value: 'support', label: 'Support' }],
    tagOptions: ['Education', 'Health Care'],
    subjectGroups: [{ state: 'UT', options: [{ value: 'UT:Counties', label: 'Counties', count: 2 }] }],
    sessionOptions: [{ value: '2026', label: '2026 Session' }],
    totalSessionCount: 1,
    stateOptions: [{ value: 'UT', label: 'UT' }],
    customFieldDefs: [],
    cfFilters: {},
    onCfFilterChange: vi.fn(),
    onStatusChange: vi.fn(),
    onPriorityChange: vi.fn(),
    onPositionChange: vi.fn(),
    onTagChange: vi.fn(),
    onSubjectChange: vi.fn(),
    onSessionChange: vi.fn(),
    onStateChange: vi.fn(),
    onMinRelevanceChange: vi.fn(),
    onMyBillsChange: vi.fn(),
    onNewMatchesChange: vi.fn(),
    onUnvotedOnlyChange: vi.fn(),
    onClearAll: vi.fn(),
  }
}

const BINARY_CF: CustomFieldDef = {
  id: 'cf-sponsor', name: 'Sponsor Support', slug: 'sponsor-support', type: 'binary', options: null, displayOrder: 0,
}
const DROPDOWN_CF: CustomFieldDef = {
  id: 'cf-region', name: 'Region', slug: 'region', type: 'dropdown', options: ['North', 'South'], displayOrder: 1,
}
const TEXT_CF: CustomFieldDef = {
  id: 'cf-notes', name: 'Notes', slug: 'notes', type: 'text', options: null, displayOrder: 2,
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
    for (const name of [/status/i, /priority/i, /position/i, /session/i, /tags/i, /subject/i]) {
      expect(screen.getByRole('button', { name })).toBeInTheDocument()
    }
  })

  it('shows a drill-down row (not the options themselves) when a dimension has options, and omits the row when it has none', () => {
    const { rerender } = renderSheet({
      tagOptions: ['Education'],
      subjectGroups: [{ state: 'UT', options: [{ value: 'UT:Counties', label: 'Counties', count: 2 }] }],
    })
    // The row itself is present as a button...
    expect(screen.getByRole('button', { name: /tags/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /subject/i })).toBeInTheDocument()
    // ...but its options are not rendered inline on the dimension list — that
    // would be the old, pre-drill-down behavior this task replaces.
    expect(screen.queryByText('Education')).not.toBeInTheDocument()
    expect(screen.queryByText('Counties')).not.toBeInTheDocument()

    rerender(<FilterSheet {...makeDefaults()} tagOptions={[]} subjectGroups={[]} />)
    expect(screen.queryByRole('button', { name: /tags/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /subject/i })).not.toBeInTheDocument()
  })

  it('a dimension row shows the count of currently-selected options within it', () => {
    renderSheet({ statuses: ['active', 'dead'], priorities: [] })
    const statusRow = screen.getByRole('button', { name: /status/i })
    expect(within(statusRow).getByText('2')).toBeInTheDocument()
    const priorityRow = screen.getByRole('button', { name: /priority/i })
    expect(within(priorityRow).queryByText('0')).not.toBeInTheDocument()
  })

  it('keeps My bills and Min. Relevance as direct controls on the dimension list, not drill-down rows', () => {
    renderSheet()
    // The "My bills" toggle chip has no drill-down chevron and doesn't
    // appear a second time as a DimensionRow.
    const myBillsButtons = screen.getAllByRole('button', { name: 'My bills' })
    expect(myBillsButtons).toHaveLength(1)
    expect(myBillsButtons[0].querySelector('svg')).not.toBeInTheDocument()
    expect(screen.getByText('Min. Relevance')).toBeInTheDocument()
  })

  it('shows New matches as a direct toggle (with a count), admin-only, not a drill-down row', () => {
    const { rerender } = renderSheet({ isAdmin: false })
    expect(screen.queryByText('New matches')).not.toBeInTheDocument()

    rerender(<FilterSheet {...makeDefaults()} isAdmin newMatchesCount={7} />)
    const newMatchesButton = screen.getByRole('button', { name: /new matches/i })
    expect(within(newMatchesButton).getByText('7')).toBeInTheDocument()
    expect(newMatchesButton.querySelector('svg')).not.toBeInTheDocument()
  })

  it('shows a count on Not yet voted, like New matches (Task 4)', () => {
    renderSheet({ unvotedCount: 7 })
    const unvotedButton = screen.getByRole('button', { name: /not yet voted/i })
    expect(within(unvotedButton).getByText('7')).toBeInTheDocument()
  })

  it('shows Not yet voted as a direct, always-visible toggle, and can both set and clear it (Critical 1)', () => {
    // Regression coverage: `unvoted` is reachable on mobile only through the
    // sheet (the desktop toolbar's scope cluster doesn't exist here, and
    // `.desktop-filter-dropdowns` is display:none on mobile — see
    // task-7-report.md, Critical 1). Before the fix, FilterSheet had no
    // "Not yet voted" control at all, so a state that IS reachable on
    // mobile (Sidebar's "N unvoted" chip, saved views) had no visible
    // indicator and no way to clear it from the sheet.
    const onUnvotedOnlyChange = vi.fn()
    const { rerender } = renderSheet({ unvotedOnly: false, onUnvotedOnlyChange })
    fireEvent.click(screen.getByRole('button', { name: /not yet voted/i }))
    expect(onUnvotedOnlyChange).toHaveBeenCalledWith(true)

    // Once active, the same control clears it back off ...
    rerender(<FilterSheet {...makeDefaults()} unvotedOnly onUnvotedOnlyChange={onUnvotedOnlyChange} />)
    fireEvent.click(screen.getByRole('button', { name: /not yet voted/i }))
    expect(onUnvotedOnlyChange).toHaveBeenCalledWith(false)

    // ... and Reset filters clears it too, same as every other active filter.
    const onClearAll = vi.fn()
    rerender(<FilterSheet {...makeDefaults()} unvotedOnly onClearAll={onClearAll} />)
    fireEvent.click(screen.getByRole('button', { name: 'Reset filters' }))
    expect(onClearAll).toHaveBeenCalledTimes(1)
  })

  it('counts an active Not yet voted toward the sheet\'s own "Reset filters" gate, matching the mobile filter button badge (Critical 1)', () => {
    // Before the fix, the mobile filter button's badge (f.totalActiveFilters,
    // which counts unvotedOnly) disagreed with this sheet's own totalActive
    // (which didn't) — the badge could read "1" over a sheet showing no
    // active filters and no "Reset filters" button.
    const { rerender } = renderSheet({ unvotedOnly: false })
    expect(screen.queryByRole('button', { name: 'Reset filters' })).not.toBeInTheDocument()

    rerender(<FilterSheet {...makeDefaults()} unvotedOnly />)
    expect(screen.getByRole('button', { name: 'Reset filters' })).toBeInTheDocument()
  })

  // Task 2: the mobile sheet's clear control must call the SAME operation as
  // desktop (BillList wires this prop straight to useBillFilters'
  // handleResetFilters) rather than a hand-duplicated subset that drifts —
  // see task-2-report.md. This test only proves the sheet still invokes
  // onClearAll once with everything active; index.test.tsx is what proves
  // the real handler actually clears every filter.
  it('clears every filter, including the ones the old copy missed', () => {
    const onClearAll = vi.fn()
    renderSheet({
      ...makeDefaults(),
      unvotedOnly: true, tags: ['Clerk'], matchAny: true, onClearAll,
    })
    fireEvent.click(screen.getByRole('button', { name: /reset filters/i }))
    expect(onClearAll).toHaveBeenCalledTimes(1)
  })

  it('labels the control the same as desktop', () => {
    renderSheet({ ...makeDefaults(), statuses: ['Introduced'] })
    expect(screen.getByRole('button', { name: /reset filters/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^clear all$/i })).not.toBeInTheDocument()
  })

  it('shows State only when the tenant has multiple known states, using the same values as its options', () => {
    const { rerender } = renderSheet({ uniqueStates: [], isMultiState: false })
    expect(screen.queryByRole('button', { name: /^state/i })).not.toBeInTheDocument()

    rerender(<FilterSheet {...makeDefaults()} uniqueStates={['UT', 'NJ']} isMultiState stateOptions={[{ value: 'UT', label: 'UT' }, { value: 'NJ', label: 'NJ' }]} />)
    expect(screen.getByRole('button', { name: /^state/i })).toBeInTheDocument()
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
    fireEvent.click(screen.getByText('Reset filters'))
    expect(onClearAll).toHaveBeenCalled()
  })

  // Level 1 <-> level 2 replaces the sheet's content in place with no page
  // navigation to carry a keyboard/screen-reader user's position, so focus
  // has to be moved by hand on both sides of the transition.
  it('moves focus onto the dimension heading on drill-in, so it is announced to a screen reader', () => {
    renderSheet()
    fireEvent.click(screen.getByRole('button', { name: /status/i }))
    const heading = screen.getByRole('heading', { name: /status/i })
    expect(document.activeElement).toBe(heading)
  })

  it('moves focus back to the originating dimension row on drill-out', () => {
    renderSheet()
    fireEvent.click(screen.getByRole('button', { name: /status/i }))
    fireEvent.click(screen.getByRole('button', { name: /back to filters/i }))
    const statusRow = screen.getByRole('button', { name: /status/i })
    expect(document.activeElement).toBe(statusRow)
  })

  it('does not steal focus back to a row on the next open after a stale drill-in/out history', () => {
    const { rerender } = renderSheet({ isOpen: true })
    fireEvent.click(screen.getByRole('button', { name: /status/i }))
    fireEvent.click(screen.getByRole('button', { name: /back to filters/i }))

    // Close and reopen — a leftover "last drilled dimension" from the
    // previous session must not yank focus onto that row again now that the
    // sheet has reset to level 1.
    rerender(<FilterSheet {...makeDefaults()} isOpen={false} />)
    rerender(<FilterSheet {...makeDefaults()} isOpen={true} />)
    const statusRow = screen.getByRole('button', { name: /status/i })
    expect(document.activeElement).not.toBe(statusRow)
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

  // The subject-exclusion warning ("Excludes all bills from ... those
  // legislatures do not publish subjects") was removed entirely — it no
  // longer renders for any combination of selected subjects and states.
  it('never renders a subject-exclusion notice, regardless of selected subjects', () => {
    const { rerender } = renderSheet({
      subjects: [],
      subjectGroups: [
        { state: 'NJ', options: [{ value: 'NJ:Education', label: 'Education', count: 4 }] },
        { state: 'UT', options: [{ value: 'UT:Counties', label: 'Counties', count: 2 }] },
      ],
    })
    fireEvent.click(screen.getByRole('button', { name: /subject/i }))
    expect(screen.queryByText(/do not publish subjects/)).not.toBeInTheDocument()

    rerender(<FilterSheet {...makeDefaults()} subjects={['UT:Counties']} />)
    expect(screen.queryByText(/do not publish subjects/)).not.toBeInTheDocument()

    rerender(<FilterSheet {...makeDefaults()} subjects={['UT:Counties', 'NJ:Education']} />)
    expect(screen.queryByText(/do not publish subjects/)).not.toBeInTheDocument()
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
    fireEvent.click(screen.getByRole('button', { name: /tags/i }))
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
    fireEvent.click(screen.getByRole('button', { name: /tags/i }))
    fireEvent.change(screen.getByPlaceholderText(/search tags/i), { target: { value: 'health' } })
    expect(screen.getByText('Health Care')).toBeInTheDocument()
    expect(screen.queryByText('Education')).not.toBeInTheDocument()
  })

  it('truncates a long subject label to a single line instead of wrapping', () => {
    const longLabel = 'Governor’s Office of Economic Opportunity and Interstate Commerce Regulation'
    renderSheet({
      subjectGroups: [{ state: 'UT', options: [{ value: 'UT:Long', label: longLabel, count: 3 }] }],
    })
    fireEvent.click(screen.getByRole('button', { name: /subject/i }))
    const labelEl = screen.getByText(longLabel)
    const style = getComputedStyle(labelEl)
    expect(style.whiteSpace).toBe('nowrap')
    expect(style.overflow).toBe('hidden')
    expect(style.textOverflow).toBe('ellipsis')
  })

  it('puts the full, untruncated subject label in the title attribute for the native browser tooltip', () => {
    const longLabel = 'Department of Health and Human Services, Behavioral Health Division'
    renderSheet({
      subjectGroups: [{ state: 'UT', options: [{ value: 'UT:Long', label: longLabel, count: 1 }] }],
    })
    fireEvent.click(screen.getByRole('button', { name: /subject/i }))
    const labelEl = screen.getByText(longLabel)
    expect(labelEl).toHaveAttribute('title', longLabel)
  })

  it('still renders the count badge alongside a truncated long subject label', () => {
    const longLabel = 'Government Operations (State Issues) and Administrative Rulemaking Oversight'
    renderSheet({
      subjectGroups: [{ state: 'UT', options: [{ value: 'UT:Long', label: longLabel, count: 42 }] }],
    })
    fireEvent.click(screen.getByRole('button', { name: /subject/i }))
    expect(screen.getByText(longLabel)).toBeInTheDocument()
    expect(screen.getByText('42')).toBeInTheDocument()
  })

  it('truncates a long tag label to a single line and exposes it via title', () => {
    const longLabel = 'A Very Long Tag Name That Would Otherwise Wrap Onto Multiple Lines'
    renderSheet({ tagOptions: [longLabel] })
    fireEvent.click(screen.getByRole('button', { name: /tags/i }))
    const labelEl = screen.getByText(longLabel)
    const style = getComputedStyle(labelEl)
    expect(style.whiteSpace).toBe('nowrap')
    expect(style.overflow).toBe('hidden')
    expect(style.textOverflow).toBe('ellipsis')
    expect(labelEl).toHaveAttribute('title', longLabel)
  })

  it('propagates a Tags selection through the existing change callback', () => {
    const onTagChange = vi.fn()
    renderSheet({ tagOptions: ['Education', 'Health Care'], onTagChange })
    fireEvent.click(screen.getByRole('button', { name: /tags/i }))
    fireEvent.click(screen.getByText('Education'))
    expect(onTagChange).toHaveBeenCalledWith(['Education'])
  })
})

// Custom fields are tenant-defined and dynamic — see lib/customFieldFilters.ts
// for the shared type-to-control mapping both this sheet and the desktop
// toolbar use. Only 'binary' (a direct toggle) and 'dropdown' (a drill-down
// options list) are filterable at all; 'text' and 'date' are not.
describe('FilterSheet — custom field filters', () => {
  it('renders a binary custom field as a direct, togglable control on the dimension list', () => {
    const onCfFilterChange = vi.fn()
    renderSheet({ customFieldDefs: [BINARY_CF], cfFilters: {}, onCfFilterChange })
    const toggle = screen.getByRole('button', { name: /sponsor support/i })
    expect(toggle).toBeInTheDocument()
    // Direct control, not a drill-down row — no chevron.
    expect(toggle.querySelector('svg')).not.toBeInTheDocument()

    fireEvent.click(toggle)
    expect(onCfFilterChange).toHaveBeenCalledWith('cf-sponsor', ['1'])
  })

  it('reflects an already-active binary custom field and clears it on a second click', () => {
    const onCfFilterChange = vi.fn()
    renderSheet({ customFieldDefs: [BINARY_CF], cfFilters: { 'cf-sponsor': ['1'] }, onCfFilterChange })
    const toggle = screen.getByRole('button', { name: /sponsor support/i })
    fireEvent.click(toggle)
    expect(onCfFilterChange).toHaveBeenCalledWith('cf-sponsor', [])
  })

  it('renders a dropdown custom field as a drill-down row whose level 2 lists its options', () => {
    const onCfFilterChange = vi.fn()
    renderSheet({ customFieldDefs: [DROPDOWN_CF], cfFilters: {}, onCfFilterChange })
    const row = screen.getByRole('button', { name: /^region$/i })
    expect(row).toBeInTheDocument()
    // Options aren't rendered until the row is drilled into.
    expect(screen.queryByText('North')).not.toBeInTheDocument()

    fireEvent.click(row)
    expect(screen.getByText('North')).toBeInTheDocument()
    expect(screen.getByText('South')).toBeInTheDocument()

    fireEvent.click(screen.getByText('North'))
    expect(onCfFilterChange).toHaveBeenCalledWith('cf-region', ['North'])
  })

  it('shows the count of currently-selected options on a dropdown custom field row', () => {
    renderSheet({ customFieldDefs: [DROPDOWN_CF], cfFilters: { 'cf-region': ['North', 'South'] } })
    const row = screen.getByRole('button', { name: /region/i })
    expect(within(row).getByText('2')).toBeInTheDocument()
  })

  it('does not render a custom field of a non-filterable type (text/date)', () => {
    renderSheet({ customFieldDefs: [TEXT_CF] })
    expect(screen.queryByText('Notes')).not.toBeInTheDocument()
  })

  it('renders no custom field affordance at all when there are zero filterable custom fields', () => {
    const { container } = renderSheet({ customFieldDefs: [] })
    // Nothing beyond the fixed set of section labels/dimension rows already
    // covered by other tests — no stray heading or empty section for custom
    // fields.
    expect(container.textContent).not.toMatch(/sponsor support/i)
    expect(container.textContent).not.toMatch(/region/i)
  })

  it('does not render a custom field affordance when only non-filterable fields are defined', () => {
    renderSheet({ customFieldDefs: [TEXT_CF] })
    // Same check as the "zero fields" case — a text-only tenant should look
    // identical to a tenant with no custom fields at all.
    expect(screen.queryByText('Notes')).not.toBeInTheDocument()
  })

  // Whole-branch review finding: the sheet had the scope-cluster ORDERING
  // (scope dimensions before bill-fact dimensions — see the "scope and
  // operator parity" describe below) but not the SEPARATOR marking the
  // boundary between them, so a binary custom field toggle sat flush against
  // My bills/New matches/Not yet voted, rendered as a byte-identical control.
  // Desktop marks this boundary with a `data-testid="scope-separator"`
  // vertical rule; the sheet needs the same marker (adapted to its vertical
  // layout) and only when there's an actual bill-fact toggle for it to
  // separate from.
  it('renders the scope/bill-fact separator when a binary custom field is present', () => {
    renderSheet({ customFieldDefs: [BINARY_CF] })
    expect(screen.getByTestId('scope-separator')).toBeInTheDocument()
  })

  it('renders no separator when there is no binary custom field to separate from', () => {
    renderSheet({ customFieldDefs: [] })
    expect(screen.queryByTestId('scope-separator')).not.toBeInTheDocument()
  })
})

// Task 8: mobile parity with desktop's scope cluster + AND/OR group operator.
describe('FilterSheet scope and operator parity', () => {
  it('lists scope dimensions (My bills, New matches, Not yet voted) before bill-fact dimensions (Status, ...)', () => {
    // Ordering already falls out of the existing hand-written layout — My
    // bills / New matches / Not yet voted render as direct level-1 controls
    // before the "Filters" section's DimensionRows (see FilterSheet.tsx) —
    // rather than from `visibleFilterDimensions` registry order, which this
    // component does not consume for its level-1 layout. This test locks
    // that already-correct behavior in place.
    renderSheet({ isAdmin: true })
    const labels = screen.getAllByRole('button').map(b => b.textContent ?? '')
    const lastScope = Math.max(
      labels.findIndex(t => t.includes('My bills')),
      labels.findIndex(t => t.includes('New matches')),
      labels.findIndex(t => t.includes('Not yet voted')),
    )
    const firstBillFact = labels.findIndex(t => /^status\b/i.test(t))
    expect(lastScope).toBeGreaterThanOrEqual(0)
    expect(firstBillFact).toBeGreaterThan(lastScope)
  })

  it('offers the operator when two groups are active', () => {
    renderSheet({ tags: ['Education'], statuses: ['active'] })
    expect(screen.getByRole('button', { name: /and/i })).toBeInTheDocument()
  })

  it('reflects matchAny from props', () => {
    // GroupOperator's aria-label is a full sentence mentioning both "AND" and
    // "OR" regardless of state (see GroupOperator.tsx) — the visible button
    // text ("AND"/"OR") is what actually flips, so assert on that directly
    // rather than the accessible name.
    renderSheet({ tags: ['Education'], statuses: ['active'], matchAny: true })
    const summary = screen.getByTestId('sheet-active-filter-chips')
    expect(within(summary).getByText('OR')).toBeInTheDocument()
    expect(within(summary).queryByText('AND')).not.toBeInTheDocument()
  })

  it('does not offer the operator with one active group', () => {
    renderSheet({ tags: ['Education'] })
    expect(screen.queryByRole('button', { name: /^and$/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^or$/i })).not.toBeInTheDocument()
  })

  it('does not offer the operator when only viewer-scope filters (My bills / Not yet voted) are active', () => {
    renderSheet({ myBills: true, unvotedOnly: true })
    expect(screen.queryByRole('button', { name: /^and$/i })).not.toBeInTheDocument()
  })

  it('propagates a toggle to the parent', () => {
    const onMatchAnyChange = vi.fn()
    renderSheet({ tags: ['Education'], statuses: ['active'], onMatchAnyChange })
    const summary = screen.getByTestId('sheet-active-filter-chips')
    fireEvent.click(within(summary).getByText('AND'))
    expect(onMatchAnyChange).toHaveBeenCalledWith(true)
  })
})

describe('FilterSheet — SheetChip accessibility (aria-pressed)', () => {
  it('exposes pressed state on the My bills toggle', () => {
    renderSheet({ myBills: true })
    expect(screen.getByRole('button', { name: 'My bills' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('exposes unpressed state on the Not yet voted toggle', () => {
    renderSheet({ unvotedOnly: false })
    expect(screen.getByRole('button', { name: /not yet voted/i })).toHaveAttribute('aria-pressed', 'false')
  })

  it('exposes pressed state on an option chip once drilled into (e.g. Status)', () => {
    renderSheet({ statuses: ['active'] })
    fireEvent.click(screen.getByRole('button', { name: /status/i }))
    expect(screen.getByRole('button', { name: /^active/i })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: /^dead/i })).toHaveAttribute('aria-pressed', 'false')
  })
})
