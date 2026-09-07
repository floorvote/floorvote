import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { buildActiveFilterGroups, relevanceChipLabel, type ActiveFilterGroupArgs } from './activeFilterGroups'
import { PRIORITY_COLORS, POSITION_COLORS } from '../../lib/chipStyles'
import { FILTER_ANY } from './FilterPanel'

const noop = vi.fn()
const base = {
  filterStates: [], filterStatuses: [], filterPositions: [], filterPriorities: [],
  filterYears: [], selectedTags: [], selectedSubjects: [], cfFilters: {},
  filterMinRelevance: 0,
  positionOptions: [], customFieldDefs: [],
  onRemoveState: noop, onRemoveStatus: noop, onRemovePosition: noop,
  onRemovePriority: noop, onRemoveYear: noop, onRemoveTag: noop,
  onRemoveSubject: noop, onRemoveCf: noop, onRemoveMinRelevance: noop,
}

describe('buildActiveFilterGroups', () => {
  it('returns no groups when nothing is selected', () => {
    expect(buildActiveFilterGroups(base)).toEqual([])
  })

  it('returns one group per active dimension, not one per chip', () => {
    const groups = buildActiveFilterGroups({ ...base, selectedTags: ['a', 'b'] })
    expect(groups).toHaveLength(1)
    expect(groups[0].key).toBe('tags')
    expect(groups[0].chips).toHaveLength(2)
  })

  // Order is this module's own, NOT derived from FILTER_DIMENSIONS — see the
  // key mismatch noted in Task 1 (session vs year, and custom fields absent).
  it('keeps a stable order across dimensions', () => {
    const groups = buildActiveFilterGroups({
      ...base, selectedTags: ['a'], filterStatuses: ['Introduced'], filterStates: ['UT'],
    })
    expect(groups.map(g => g.key)).toEqual(['state', 'status', 'tags'])
  })

  it('omits viewer-scope dimensions entirely, even if present on the input object', () => {
    // unvoted and newMatches move to the scope cluster in Task 7; they must
    // never appear between operators. ActiveFilterGroupArgs carries no
    // unvotedOnly/newMatches fields at all, but a careless future change could
    // still read them off the object (JS doesn't strip extra properties) — seed
    // them via a cast so this test can actually fail if that happens, unlike a
    // call with the untouched `base` fixture (which can only ever prove the
    // module returns `[]` for empty input, already covered above).
    const withScope = {
      ...base, filterStates: ['UT'], unvotedOnly: true, newMatches: true,
    } as unknown as ActiveFilterGroupArgs
    const groups = buildActiveFilterGroups(withScope)
    expect(groups.map(g => g.key)).not.toContain('unvoted')
    expect(groups.map(g => g.key)).not.toContain('newMatches')
  })

  it('renders relevance as a single-chip group above zero', () => {
    const groups = buildActiveFilterGroups({ ...base, filterMinRelevance: 3 })
    expect(groups).toHaveLength(1)
    expect(groups[0].key).toBe('minRelevance')
    expect(groups[0].chips).toHaveLength(1)
  })

  it('renders no relevance group at zero, even alongside other active filters', () => {
    // A bare `base` call can only prove groups === [], which the first test in
    // this file already covers regardless of how minRelevance is handled. Add
    // an unrelated active dimension so the assertion is specifically about
    // 'minRelevance' being absent, and can fail if the >0 guard is ever dropped.
    const groups = buildActiveFilterGroups({ ...base, filterMinRelevance: 0, filterStates: ['UT'] })
    expect(groups.map(g => g.key)).not.toContain('minRelevance')
  })

  it('labels relevance the way the slider does', () => {
    expect(relevanceChipLabel(3)).toBe('Relevance 3+')
    expect(relevanceChipLabel(10)).toBe('Relevance 10')
  })

  it('renders a subject chip with its state prefix', () => {
    const groups = buildActiveFilterGroups({ ...base, selectedSubjects: ['UT:Elections'] })
    render(<>{groups[0].chips}</>)
    expect(screen.getByText('UT: Elections')).toBeInTheDocument()
  })

  it('labels the FILTER_ANY / "none" special cases for position and priority', () => {
    const groups = buildActiveFilterGroups({
      ...base, filterPositions: [FILTER_ANY], filterPriorities: [FILTER_ANY, 'none'],
    })
    render(<>{groups.flatMap(g => g.chips)}</>)
    expect(screen.getByText('Any position')).toBeInTheDocument()
    expect(screen.getByText('Any priority')).toBeInTheDocument()
    expect(screen.getByText('No priority')).toBeInTheDocument()
  })

  it('labels the FILTER_ANY special case for tags', () => {
    const groups = buildActiveFilterGroups({ ...base, selectedTags: [FILTER_ANY] })
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
    const groups = buildActiveFilterGroups({ ...base, filterPositions: ['Support'] })
    const { container } = render(<>{groups[0].chips}</>)
    const span = container.querySelector('span')
    expect(span).toHaveStyle({
      background: POSITION_COLORS.Support.bg,
      border: `1px solid ${POSITION_COLORS.Support.border}`,
    })
  })

  it('renders a real priority value using the priority colour map with no border, unlike ActiveChip', () => {
    // Every ActiveChip variant paints a 1px solid border; the priority span's
    // style object omits `border` entirely (see activeFilterGroups.tsx), which
    // is exactly the flattening a careless refactor would erase.
    const groups = buildActiveFilterGroups({ ...base, filterPriorities: ['high'] })
    const { container } = render(<>{groups[0].chips}</>)
    const span = container.querySelector('span')
    expect(span).toHaveStyle({ background: PRIORITY_COLORS.high.fill, color: PRIORITY_COLORS.high.text })
    expect(span?.style.border).toBe('')
  })
})
