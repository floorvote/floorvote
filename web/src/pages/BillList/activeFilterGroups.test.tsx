import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { buildActiveFilterGroups, relevanceChipLabel, type ActiveFilterGroupArgs } from './activeFilterGroups'
import { PRIORITY_COLORS, POSITION_COLORS } from '../../lib/chipStyles'
import { FILTER_ANY, activeFilters, withBillFilter } from '../../../../shared/billFilter'

const noop = vi.fn()
const base = {
  state: [], status: [], stage: [], position: [], priority: [],
  year: [], tag: [], subject: [], field: {},
  minRelevance: 0,
  positionOptions: [], customFieldDefs: [], isMultiState: false,
  onRemoveState: noop, onRemoveStatus: noop, onRemoveStage: noop, onRemovePosition: noop,
  onRemovePriority: noop, onRemoveYear: noop, onRemoveTag: noop,
  onRemoveSubject: noop, onRemoveField: noop, onRemoveMinRelevance: noop,
}

describe('buildActiveFilterGroups', () => {
  it('returns no groups when nothing is selected', () => {
    expect(buildActiveFilterGroups(base)).toEqual([])
  })

  it('returns one group per active dimension, not one per chip', () => {
    const groups = buildActiveFilterGroups({ ...base, tag: ['a', 'b'] })
    expect(groups).toHaveLength(1)
    expect(groups[0].key).toBe('tag')
    expect(groups[0].chips).toHaveLength(2)
  })

  // Order is this module's own, NOT derived from FILTER_DIMENSIONS — see the
  // key mismatch noted in Task 1 (session vs year, and custom fields absent).
  it('keeps a stable order across dimensions', () => {
    const groups = buildActiveFilterGroups({
      ...base, tag: ['a'], status: ['Introduced'], state: ['UT'],
    })
    expect(groups.map(g => g.key)).toEqual(['state', 'status', 'tag'])
  })

  it('omits viewer-scope dimensions entirely, even if present on the input object', () => {
    // unvoted and newMatches move to the scope cluster in Task 7; they must
    // never appear between operators. ActiveFilterGroupArgs carries no
    // unvoted/newMatches fields at all, but a careless future change could
    // still read them off the object (JS doesn't strip extra properties) — seed
    // them via a cast so this test can actually fail if that happens, unlike a
    // call with the untouched `base` fixture (which can only ever prove the
    // module returns `[]` for empty input, already covered above).
    const withScope = {
      ...base, state: ['UT'], unvoted: true, newMatches: true,
    } as unknown as ActiveFilterGroupArgs
    const groups = buildActiveFilterGroups(withScope)
    expect(groups.map(g => g.key)).not.toContain('unvoted')
    expect(groups.map(g => g.key)).not.toContain('newMatches')
  })

  it('draws the stage chips and the status chips in one group, the stages after the statuses (#677)', () => {
    const onRemoveStage = vi.fn()
    const groups = buildActiveFilterGroups({ ...base, status: ['Introduced'], stage: ['passed'], onRemoveStage })
    expect(groups.map(g => g.key)).toEqual(['status'])
    expect(groups[0].chips).toHaveLength(2)
    render(<>{groups[0].chips}</>)
    expect(screen.getByText('Stage: Passed legislature')).toBeInTheDocument()
    expect(screen.getByText('Introduced')).toBeInTheDocument()
  })

  it('draws a stage alone as the Status group, and removes it through the stage callback (#677)', () => {
    const onRemoveStage = vi.fn()
    const onRemoveStatus = vi.fn()
    const groups = buildActiveFilterGroups({ ...base, stage: ['enacted', 'vetoed'], onRemoveStage, onRemoveStatus })
    expect(groups.map(g => g.key)).toEqual(['status'])
    render(<>{groups[0].chips}</>)
    expect(screen.getByText('Stage: Enacted')).toBeInTheDocument()
    fireEvent.click(screen.getAllByRole('button', { name: '×' })[1])
    expect(onRemoveStage).toHaveBeenCalledWith('vetoed')
    expect(onRemoveStatus).not.toHaveBeenCalled()
  })

  it('removes a status chip through the status callback when stage chips sit beside it (#677)', () => {
    const onRemoveStage = vi.fn()
    const onRemoveStatus = vi.fn()
    const groups = buildActiveFilterGroups({ ...base, status: ['Introduced'], stage: ['enacted'], onRemoveStage, onRemoveStatus })
    render(<>{groups[0].chips}</>)
    fireEvent.click(screen.getAllByRole('button', { name: '×' })[0])
    expect(onRemoveStatus).toHaveBeenCalledWith('Introduced')
    expect(onRemoveStage).not.toHaveBeenCalled()
  })

  it('words a stage it does not know as it was given, under the same Stage prefix (#677)', () => {
    const groups = buildActiveFilterGroups({ ...base, stage: ['mystery'] })
    render(<>{groups[0].chips}</>)
    expect(screen.getByText('Stage: mystery')).toBeInTheDocument()
  })

  it('draws the Status group once the list of active filters holds the status entry, for a stage alone (#677)', () => {
    const active = activeFilters(withBillFilter({ stage: ['enacted'] }))
    expect(buildActiveFilterGroups({ ...base, stage: ['enacted'], active }).map(g => g.key)).toEqual(['status'])
    expect(buildActiveFilterGroups({ ...base, stage: ['enacted'], active: [] })).toEqual([])
  })

  it('renders relevance as a single-chip group above zero', () => {
    const groups = buildActiveFilterGroups({ ...base, minRelevance: 3 })
    expect(groups).toHaveLength(1)
    expect(groups[0].key).toBe('minRelevance')
    expect(groups[0].chips).toHaveLength(1)
  })

  it('renders no relevance group at zero, even alongside other active filters', () => {
    // A bare `base` call can only prove groups === [], which the first test in
    // this file already covers regardless of how minRelevance is handled. Add
    // an unrelated active dimension so the assertion is specifically about
    // 'minRelevance' being absent, and can fail if the >0 guard is ever dropped.
    const groups = buildActiveFilterGroups({ ...base, minRelevance: 0, state: ['UT'] })
    expect(groups.map(g => g.key)).not.toContain('minRelevance')
  })

  it('labels relevance the way the slider does', () => {
    expect(relevanceChipLabel(3)).toBe('Relevance 3+')
    expect(relevanceChipLabel(10)).toBe('Relevance 10')
  })

  it('renders a subject chip with its state prefix in a multi-state tenant', () => {
    const groups = buildActiveFilterGroups({ ...base, isMultiState: true, subject: ['UT:Elections'] })
    render(<>{groups[0].chips}</>)
    expect(screen.getByText('UT: Elections')).toBeInTheDocument()
  })

  // In a single-state tenant every subject carries the same state prefix, so
  // printing it on each chip is pure noise. The stored value keeps the prefix
  // either way — only the label drops it, so removal still matches.
  it('drops the state prefix from subject chips in a single-state tenant', () => {
    const onRemoveSubject = vi.fn()
    const groups = buildActiveFilterGroups({ ...base, subject: ['NJ:State and Local Government'], onRemoveSubject })
    render(<>{groups[0].chips}</>)
    expect(screen.getByText('State and Local Government')).toBeInTheDocument()
    expect(screen.queryByText('NJ: State and Local Government')).not.toBeInTheDocument()
    screen.getByRole('button').click()
    expect(onRemoveSubject).toHaveBeenCalledWith('NJ:State and Local Government')
  })

  it('leaves an unprefixed subject alone in either tenant shape', () => {
    for (const isMultiState of [false, true]) {
      const groups = buildActiveFilterGroups({ ...base, isMultiState, subject: ['Elections'] })
      const { unmount } = render(<>{groups[0].chips}</>)
      expect(screen.getByText('Elections')).toBeInTheDocument()
      unmount()
    }
  })

  it('labels the FILTER_ANY / "none" special cases for position and priority', () => {
    const groups = buildActiveFilterGroups({
      ...base, position: [FILTER_ANY], priority: [FILTER_ANY, 'none'],
    })
    render(<>{groups.flatMap(g => g.chips)}</>)
    expect(screen.getByText('Any position')).toBeInTheDocument()
    expect(screen.getByText('Any priority')).toBeInTheDocument()
    expect(screen.getByText('No priority')).toBeInTheDocument()
  })

  it('labels the FILTER_ANY special case for tags', () => {
    const groups = buildActiveFilterGroups({ ...base, tag: [FILTER_ANY] })
    render(<>{groups[0].chips}</>)
    expect(screen.getByText('Any tag')).toBeInTheDocument()
  })

  // Position and priority chips are bespoke inline-styled spans with their own
  // colour maps and their own '×' markup — NOT the shared ActiveChip component
  // (which only ever paints one of five fixed ChipColor palettes: gray/blue/
  // red/green/purple, always with a border). A careless refactor could easily
  // flatten these into plain ActiveChip calls and still pass every other test
  // in this file, since ActiveChip renders the same <span><button>×</button>
  // structure. Pin the one real visual distinction each carries instead.
  it('renders a real position value using the position colour map, not an ActiveChip palette', () => {
    const groups = buildActiveFilterGroups({ ...base, position: ['Support'] })
    const { container } = render(<>{groups[0].chips}</>)
    const span = container.querySelector('span')
    // Inline values compared as written: the colors are CSS variables, which
    // toHaveStyle can't parse inside the border shorthand.
    expect(span?.style.background).toBe(POSITION_COLORS.Support.bg)
    expect(span?.style.border).toBe(`1px solid ${POSITION_COLORS.Support.border}`)
  })

  it('renders a real priority value using the priority colour map with no border, unlike ActiveChip', () => {
    // Every ActiveChip variant paints a 1px solid border; the priority span's
    // style object omits `border` entirely (see activeFilterGroups.tsx), which
    // is exactly the flattening a careless refactor would erase.
    const groups = buildActiveFilterGroups({ ...base, priority: ['high'] })
    const { container } = render(<>{groups[0].chips}</>)
    const span = container.querySelector('span')
    expect(span).toHaveStyle({ background: PRIORITY_COLORS.high.fill, color: PRIORITY_COLORS.high.text })
    expect(span?.style.border).toBe('')
  })
})

describe('buildActiveFilterGroups: drawn from the one list of active filters', () => {
  it('draws a group only when the list holds its filter', () => {
    const active = activeFilters(withBillFilter({ status: ['Introduced'] }))
    const groups = buildActiveFilterGroups({ ...base, status: ['Introduced'], tag: ['a'], active })
    expect(groups.map(g => g.key)).toEqual(['status'])
  })

  it('draws every group the list holds, in the chip row order', () => {
    const f = withBillFilter({ state: ['UT'], status: ['Introduced'], tag: ['a'], myBills: true, search: 'x' })
    const groups = buildActiveFilterGroups({ ...base, state: ['UT'], status: ['Introduced'], tag: ['a'], active: activeFilters(f) })
    expect(groups.map(g => g.key)).toEqual(['state', 'status', 'tag'])
  })

  it('draws no group for a filter the list leaves out as hidden', () => {
    const f = withBillFilter({ state: ['UT'], status: ['Introduced'] })
    const groups = buildActiveFilterGroups({ ...base, state: ['UT'], status: ['Introduced'], active: activeFilters(f, { hidden: ['state'] }) })
    expect(groups.map(g => g.key)).toEqual(['status'])
  })

  it('draws a custom field group by the field key the list holds', () => {
    const f = withBillFilter({ field: { 'cf-1': ['a'], 'cf-2': ['b'] } })
    const groups = buildActiveFilterGroups({ ...base, field: { 'cf-1': ['a'], 'cf-2': ['b'] }, active: activeFilters(f, { hidden: [] }) })
    expect(groups.map(g => g.key)).toEqual(['field.cf-1', 'field.cf-2'])
  })
})
