import { useCallback, useMemo, useRef, useState } from 'react'
import { useVirtualizer, defaultRangeExtractor } from '@tanstack/react-virtual'
import type { Range } from '@tanstack/react-virtual'
import { color, fontSize, fontWeight, radius } from '../styles/tokens'
import { COUNT_BADGE } from '../lib/chipStyles'

// A dimension's options, optionally grouped under a heading. Pass a single
// group with no `heading` for a flat dimension (Tags); pass one group per
// state, each with `heading` set to the state name, for a dimension whose
// vocabulary is state-qualified (Subjects) — headings only render when more
// than one group survives the current search, same rule as the desktop
// SubjectFilterDropdown in FilterPanel.tsx.
export interface FilterSheetVirtualGroup {
  key: string
  heading?: string
  options: Array<{ value: string; label: string; count?: number }>
}

type Row =
  | { type: 'header'; key: string; label: string }
  | { type: 'option'; key: string; value: string; label: string; count?: number }

const OPTION_ROW_HEIGHT = 44
const HEADER_ROW_HEIGHT = 28
const LIST_HEIGHT = 340

/**
 * Search-filtered, virtualized option list shared by the mobile filter
 * sheet's long dimensions (Subjects, Tags). Extracted from FilterSheet.tsx
 * rather than duplicated between those two sections, but kept independent of
 * FilterPanel.tsx's SubjectFilterDropdown (the desktop control) — that
 * component was just rebuilt and is out of scope to modify, and its
 * virtualized list lives inside a floating dropdown panel with its own
 * sizing, while this one renders inline as the full body of a bottom sheet.
 * The underlying technique (fixed row heights, TanStack Virtual, a sticky
 * "currently active header" tracked via rangeExtractor) is the same recipe;
 * see the comment above SubjectFilterDropdown for why that recipe is needed
 * and how the sticky-row trick works.
 */
export function FilterSheetVirtualList({
  groups, selected, onToggle, searchPlaceholder, ariaLabel,
}: {
  groups: FilterSheetVirtualGroup[]
  selected: string[]
  onToggle: (value: string) => void
  searchPlaceholder: string
  ariaLabel: string
}) {
  const [search, setSearch] = useState('')
  const scrollRef = useRef<HTMLDivElement | null>(null)

  const filteredGroups = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return groups
    return groups
      .map(group => ({ ...group, options: group.options.filter(o => o.label.toLowerCase().includes(q)) }))
      .filter(group => group.options.length > 0)
  }, [groups, search])

  const showHeadings = filteredGroups.length > 1

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = []
    for (const group of filteredGroups) {
      if (showHeadings && group.heading) out.push({ type: 'header', key: `header:${group.key}`, label: group.heading })
      for (const opt of group.options) out.push({ type: 'option', key: `option:${opt.value}`, value: opt.value, label: opt.label, count: opt.count })
    }
    return out
  }, [filteredGroups, showHeadings])

  const stickyIndexes = useMemo(
    () => rows.reduce<number[]>((acc, row, i) => { if (row.type === 'header') acc.push(i); return acc }, []),
    [rows],
  )

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
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => rows[i]?.type === 'header' ? HEADER_ROW_HEIGHT : OPTION_ROW_HEIGHT,
    overscan: 8,
    getItemKey: (i) => rows[i]?.key ?? i,
    rangeExtractor,
  })

  return (
    <div role="group" aria-label={ariaLabel}>
      <div style={{ padding: '0 0 10px' }}>
        <input
          type="text"
          placeholder={searchPlaceholder}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{
            width: '100%', boxSizing: 'border-box', fontSize: fontSize.sm, padding: '8px 12px',
            border: `1px solid ${color.borderDefault}`, borderRadius: radius.md,
          }}
        />
      </div>
      {rows.length === 0 ? (
        <div style={{ padding: '16px 0', fontSize: fontSize.sm, color: color.textMuted }}>
          No matches for &ldquo;{search.trim()}&rdquo;.
        </div>
      ) : (
        <div
          ref={scrollRef}
          style={{ height: LIST_HEIGHT, overflowY: 'auto', position: 'relative' }}
        >
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {virtualizer.getVirtualItems().map(virtualRow => {
              const row = rows[virtualRow.index]
              const sticky = activeStickyIndexRef.current === virtualRow.index
              const positionStyle: React.CSSProperties = sticky
                ? { position: 'sticky', top: 0, zIndex: 2 }
                : { position: 'absolute', top: virtualRow.start, zIndex: 1 }
              return (
                <div key={virtualRow.key} data-index={virtualRow.index} style={{ ...positionStyle, left: 0, width: '100%' }}>
                  {row.type === 'header' ? (
                    <div style={{
                      height: HEADER_ROW_HEIGHT, boxSizing: 'border-box', display: 'flex', alignItems: 'center',
                      fontSize: fontSize.xs, fontWeight: fontWeight.semibold, color: color.textMuted,
                      textTransform: 'uppercase', letterSpacing: '0.05em', background: color.white,
                    }}>
                      {row.label}
                    </div>
                  ) : (
                    <label style={{
                      height: OPTION_ROW_HEIGHT, boxSizing: 'border-box',
                      display: 'flex', alignItems: 'center', gap: 10,
                      cursor: 'pointer', fontSize: fontSize.sm,
                      color: selected.includes(row.value) ? color.linkBlue : color.textSlate,
                      background: selected.includes(row.value) ? color.bgInfo : color.white,
                    }}>
                      <input
                        type="checkbox"
                        checked={selected.includes(row.value)}
                        onChange={() => onToggle(row.value)}
                        style={{ margin: 0, accentColor: color.accentBlue }}
                      />
                      {row.label}
                      {row.count !== undefined && (
                        <span style={{ ...COUNT_BADGE, marginLeft: 'auto' }}>{row.count.toLocaleString()}</span>
                      )}
                    </label>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
