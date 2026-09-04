import { useCallback, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { useVirtualizer, defaultRangeExtractor } from '@tanstack/react-virtual'
import type { Range } from '@tanstack/react-virtual'

// Shared virtualized, search-filtered, state/group-headed option list — the
// recipe behind SubjectFilterDropdown (FilterPanel.tsx, desktop) and
// FilterSheetVirtualList (mobile bottom sheet). Both dimensions can run into
// the thousands of options, so the list is virtualized (@tanstack/react-virtual);
// both group their options under a heading (state, for Subjects) that should
// only appear when more than one group survives the current search — a single
// group gets a flat list since the heading would be noise.
//
// Extracted so the sticky-header push-out fix lives in exactly one place
// rather than being re-implemented (and re-debugged) at both call sites.

export interface StickyVirtualOption {
  value: string
  label: string
  count?: number
}

export interface StickyVirtualGroup {
  /** Stable React/virtualizer key for the group — need not equal `heading`. */
  key: string
  /** Group heading text (e.g. a state code). Rendered only when more than one
   *  group survives the current search. */
  heading: string
  options: StickyVirtualOption[]
}

export type StickyVirtualRow =
  | { type: 'header'; key: string; label: string }
  | { type: 'option'; key: string; value: string; label: string; count?: number }

/** A header row's layout, in the list's own fixed-height coordinate space
 *  (i.e. cumulative row heights, not viewport/DOM pixels). */
export interface StickyHeaderLayout {
  index: number
  top: number
  height: number
}

/**
 * Pure push-out calculation for a virtualized (absolutely-positioned) sticky
 * header — the same "next section slides the pinned one up and out" effect
 * `position: sticky` gives for free in normal document flow, reproduced by
 * hand because virtual rows have no real flow to push against.
 *
 * Returns 0 (no push yet) when the pinned header hasn't actually reached its
 * pinning point, or there is no next header to push it. Otherwise returns how
 * far (px) to slide the pinned header upward: as `nextHeaderTop` approaches
 * `scrollOffset` from below, the offset ramps from 0 up to `pinnedHeaderHeight`
 * (fully displaced) — clamped so it never goes negative.
 */
export function computeStickyPushOffset({
  scrollOffset,
  pinnedHeaderTop,
  pinnedHeaderHeight,
  nextHeaderTop,
}: {
  scrollOffset: number
  pinnedHeaderTop: number
  pinnedHeaderHeight: number
  nextHeaderTop?: number
}): number {
  if (scrollOffset < pinnedHeaderTop) return 0 // not pinned yet
  if (nextHeaderTop === undefined) return 0 // no group behind it to push it out
  const distance = nextHeaderTop - scrollOffset
  if (distance >= pinnedHeaderHeight) return 0
  return Math.max(0, pinnedHeaderHeight - distance)
}

/** Cumulative top offset (in row-height units) of every row, given each row's
 *  fixed height by type. Rows are fixed-height by design (see the header
 *  comment on SUBJECT_OPTION_ROW_HEIGHT in FilterPanel.tsx) precisely so this
 *  can be a plain prefix sum rather than a DOM measurement. */
export function computeRowOffsets(rows: StickyVirtualRow[], headerHeight: number, optionHeight: number): number[] {
  const offsets: number[] = []
  let acc = 0
  for (const row of rows) {
    offsets.push(acc)
    acc += row.type === 'header' ? headerHeight : optionHeight
  }
  return offsets
}

export interface UseStickyGroupedVirtualListOptions {
  groups: StickyVirtualGroup[]
  headerHeight: number
  optionHeight: number
  overscan?: number
  getScrollElement: () => HTMLDivElement | null
}

export function useStickyGroupedVirtualList({
  groups, headerHeight, optionHeight, overscan = 8, getScrollElement,
}: UseStickyGroupedVirtualListOptions) {
  const [search, setSearch] = useState('')

  // Search narrows each group's options by label (case-insensitive); a group
  // with no surviving matches is dropped entirely rather than shown empty.
  const filteredGroups = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return groups
    return groups
      .map(group => ({ ...group, options: group.options.filter(o => o.label.toLowerCase().includes(q)) }))
      .filter(group => group.options.length > 0)
  }, [groups, search])

  const showHeadings = filteredGroups.length > 1

  const rows = useMemo<StickyVirtualRow[]>(() => {
    const out: StickyVirtualRow[] = []
    for (const group of filteredGroups) {
      if (showHeadings) out.push({ type: 'header', key: `header:${group.key}`, label: group.heading })
      for (const opt of group.options) out.push({ type: 'option', key: `option:${opt.value}`, value: opt.value, label: opt.label, count: opt.count })
    }
    return out
  }, [filteredGroups, showHeadings])

  const rowOffsets = useMemo(() => computeRowOffsets(rows, headerHeight, optionHeight), [rows, headerHeight, optionHeight])

  const stickyIndexes = useMemo(
    () => rows.reduce<number[]>((acc, row, i) => { if (row.type === 'header') acc.push(i); return acc }, []),
    [rows],
  )

  // Tracks which header row (if any) is the "currently pinned" one for the
  // active scroll position — TanStack Virtual's documented sticky-row recipe.
  // Set inside rangeExtractor (called during render) rather than via
  // effect/state, so it stays in sync with the very range it's deciding.
  const activeStickyIndexRef = useRef(-1)

  const rangeExtractor = useCallback((range: Range) => {
    activeStickyIndexRef.current = stickyIndexes.length === 0
      ? -1
      : [...stickyIndexes].reverse().find(index => range.startIndex >= index) ?? stickyIndexes[0]
    const next = new Set(defaultRangeExtractor(range))
    if (activeStickyIndexRef.current >= 0) next.add(activeStickyIndexRef.current)
    return [...next].sort((a, b) => a - b)
  }, [stickyIndexes])

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement,
    estimateSize: (i) => rows[i]?.type === 'header' ? headerHeight : optionHeight,
    overscan,
    getItemKey: (i) => rows[i]?.key ?? i,
    rangeExtractor,
  })

  const activeStickyIndex = activeStickyIndexRef.current
  const scrollOffset = virtualizer.scrollOffset ?? 0

  // Push-out offset for whichever header is currently pinned, and whether it
  // still deserves its "stuck" shadow (see StickyGroupHeader) — both derived
  // from the same fixed-height row layout used above.
  let pushOffset = 0
  let stuck = false
  if (activeStickyIndex >= 0) {
    const pinnedHeaderTop = rowOffsets[activeStickyIndex]
    const nextHeaderIndex = stickyIndexes.find(i => i > activeStickyIndex)
    const nextHeaderTop = nextHeaderIndex !== undefined ? rowOffsets[nextHeaderIndex] : undefined
    pushOffset = computeStickyPushOffset({ scrollOffset, pinnedHeaderTop, pinnedHeaderHeight: headerHeight, nextHeaderTop })
    stuck = scrollOffset >= pinnedHeaderTop
  }

  return { search, setSearch, rows, virtualizer, activeStickyIndex, pushOffset, stuck }
}

/**
 * Positioning style for a virtual row's wrapper. Only the active sticky
 * header row (`isSticky`) becomes `position: sticky` — every other row stays
 * absolutely positioned at its measured `start`, as usual for a virtualized
 * list. Toggling the *wrapper's* position (rather than nesting a sticky
 * element inside an absolutely-positioned one, which would scroll its own
 * containing block out of view) is what keeps the active header pinned
 * regardless of scroll position — TanStack Virtual's documented recipe.
 *
 * `pushOffset` is only meaningful when `isSticky`: it's the push-out amount
 * from computeStickyPushOffset, plus the 1px seam overlap StickyGroupHeader's
 * doc comment explains (same trick as DateDivider's `stickyTop - 1`).
 */
export function getRowWrapperStyle(start: number, isSticky: boolean, pushOffset = 0): CSSProperties {
  return isSticky
    ? { position: 'sticky', top: -1 - pushOffset, left: 0, width: '100%', zIndex: 2 }
    : { position: 'absolute', top: start, left: 0, width: '100%', zIndex: 1 }
}
