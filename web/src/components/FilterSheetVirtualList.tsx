import { useMemo, useRef } from 'react'
import { color, fontSize, radius } from '../styles/tokens'
import { COUNT_BADGE } from '../lib/chipStyles'
import { useStickyGroupedVirtualList, getRowWrapperStyle } from './stickyGroupedVirtualList'
import { StickyGroupHeader } from './ui/StickyGroupHeader'

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

const OPTION_ROW_HEIGHT = 44
const HEADER_ROW_HEIGHT = 28
const LIST_HEIGHT = 340

/**
 * Search-filtered, virtualized option list shared by the mobile filter
 * sheet's long dimensions (Subjects, Tags). Extracted from FilterSheet.tsx
 * rather than duplicated between those two sections. The underlying recipe
 * (fixed row heights, TanStack Virtual, a sticky "currently active header"
 * with hand-rolled push-out) lives in stickyGroupedVirtualList.ts, shared
 * with SubjectFilterDropdown (the desktop control in FilterPanel.tsx) — see
 * that module for why virtualized rows need a hand-rolled push-out at all.
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
  const scrollRef = useRef<HTMLDivElement | null>(null)

  const normalizedGroups = useMemo(
    () => groups.map(g => ({ key: g.key, heading: g.heading ?? g.key, options: g.options })),
    [groups],
  )

  const { search, setSearch, rows, virtualizer, activeStickyIndex, pushOffset, stuck } = useStickyGroupedVirtualList({
    groups: normalizedGroups,
    headerHeight: HEADER_ROW_HEIGHT,
    optionHeight: OPTION_ROW_HEIGHT,
    getScrollElement: () => scrollRef.current,
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
              const sticky = activeStickyIndex === virtualRow.index
              return (
                <div key={virtualRow.key} data-index={virtualRow.index} style={getRowWrapperStyle(virtualRow.start, sticky, pushOffset)}>
                  {row.type === 'header' ? (
                    <StickyGroupHeader label={row.label} height={HEADER_ROW_HEIGHT} stuck={sticky && stuck} pushOffset={pushOffset} padding="0" />
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
