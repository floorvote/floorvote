import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent } from 'react'
import { color, radius, fontSize, fontWeight, shadow } from '../../styles/tokens'
import { filterDimensionLabel } from '../../lib/filterDimensions'
import { useMenuAlign } from '../../hooks/useMenuAlign'
import type { CommitteeGroup } from '../../lib/committeeGroups'
import { CountBadge } from './FilterPanel'
import { StickyGroupHeader } from '../../components/ui/StickyGroupHeader'
import { computeRowOffsets, getRowWrapperStyle, useStickyGroupedVirtualList } from '../../components/stickyGroupedVirtualList'

export type CommitteeScope = 'current' | 'any'

/** The scope switch's two choices, in the order the menu shows them. */
export const COMMITTEE_SCOPES: ReadonlyArray<{ value: CommitteeScope; label: string }> = [
  { value: 'current', label: 'Current committee' },
  { value: 'any', label: 'Any referral' },
]

/** What the Committee control says on hover. */
export const COMMITTEE_FILTER_HINT = 'Filter by the committee a bill is in now, or any committee it was referred to.'

/**
 * The current committee or any referral, as two radios, on the gray of the state headings so the switch reads as part
 * of the menu's chrome. `style` adjusts it where it sits (the mobile sheet rounds it).
 */
export function CommitteeScopeSwitch({ scope, onScopeChange, name, style }: { scope: CommitteeScope; onScopeChange: (scope: CommitteeScope) => void; name: string; style?: CSSProperties }) {
  return (
    <div role="radiogroup" aria-label="Match a bill's committee by" style={{ display: 'flex', gap: 12, padding: '7px 12px', fontSize: fontSize.sm, color: color.textSlate, background: color.surfaceMuted, flex: '0 0 auto', ...style }}>
      {COMMITTEE_SCOPES.map(s => (
        <label key={s.value} style={{ display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer', whiteSpace: 'nowrap' }}>
          <input
            type="radio"
            name={name}
            checked={scope === s.value}
            onChange={() => onScopeChange(s.value)}
            style={{ margin: 0, accentColor: color.accentBlue }}
          />
          {s.label}
        </label>
      ))}
    </div>
  )
}

// Fixed row heights, as the Subject menu's (see SUBJECT_OPTION_ROW_HEIGHT in FilterPanel.tsx): the list is virtualized
// by the shared sticky grouped list, so a row's height is the one the virtualizer lays out by. A name that would wrap
// is cut off with an ellipsis instead, and `title` carries the full name.
const OPTION_ROW_HEIGHT = 28
const HEADER_ROW_HEIGHT = 24
const LIST_HEIGHT = 280
/** The search box above the list, and the scope switch under it, so the menu's tallest height holds the whole list. */
const CHROME_HEIGHT = 90
/** The old menu's widest size: wide enough that a long name still shows the " (Senate)" or " (House)" that tells same-named committees apart. */
const MENU_WIDTH = 400

/**
 * The Committee filter (#471): each committee with its bill count, under its state on a multi-state instance, and a
 * switch between the committee a bill is in now and any committee it was referred to. The options come from
 * `committeeGroups`.
 *
 * It is built like the Subject menu (`SubjectFilterDropdown`): a search box on top, then the list, virtualized, with
 * the state heading of the committees on screen pinned at the top (the shared `useStickyGroupedVirtualList`). The
 * scope switch sits between the two on the headings' gray.
 */
export function CommitteeFilterDropdown({ groups, selected, onChange, scope, onScopeChange, showStates }: {
  groups: CommitteeGroup[]
  selected: string[]
  onChange: (next: string[]) => void
  scope: CommitteeScope
  onScopeChange: (scope: CommitteeScope) => void
  /** Head each state's committees with its name: true on a multi-state instance. */
  showStates: boolean
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  /** A committee the arrow keys are moving to, whose row the virtualized list has yet to render. */
  const pendingFocus = useRef<string | null>(null)
  const menuAlign = useMenuAlign(open, triggerRef, undefined, MENU_WIDTH)
  const label = filterDimensionLabel('committee')

  // Without state headings (a single-state instance), the committees are one group, and the list shows no heading.
  const listGroups = useMemo(
    () => showStates
      ? groups.map(g => ({ key: g.state, heading: g.state, options: g.options }))
      : [{ key: 'all', heading: '', options: groups.flatMap(g => g.options) }],
    [groups, showStates],
  )
  const { search, setSearch, rows, virtualizer, activeStickyIndex, pushOffset, stuck } = useStickyGroupedVirtualList({
    groups: listGroups,
    headerHeight: HEADER_ROW_HEIGHT,
    optionHeight: OPTION_ROW_HEIGHT,
    getScrollElement: () => scrollRef.current,
  })

  // A move still waiting for its row is dropped when the menu closes, so it cannot pull focus on a later render.
  useEffect(() => {
    if (!open) pendingFocus.current = null
  }, [open])

  useEffect(() => {
    if (!open) return
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  // Focus moves into the menu when it opens, so the arrow keys reach it however it was opened (as FilterDropdown).
  useEffect(() => {
    if (!open) return
    const radios = Array.from(menuRef.current?.querySelectorAll<HTMLInputElement>('input[type="radio"]') ?? [])
    ;(radios.find(r => r.checked) ?? radios[0])?.focus()
  }, [open])

  // The arrow keys move to a committee the list has yet to render: scroll to it, and focus it once it is there.
  useEffect(() => {
    const value = pendingFocus.current
    if (value === null) return
    const box = committeeBox(value)
    if (!box) return
    pendingFocus.current = null
    box.focus({ preventScroll: true })
  })

  function committeeBox(value: string): HTMLInputElement | undefined {
    return Array.from(menuRef.current?.querySelectorAll<HTMLInputElement>('input[data-committee]') ?? []).find(b => b.dataset.committee === value)
  }

  /** Scroll a committee's row into the list's view, clear of the pinned heading, then focus its checkbox. */
  function focusCommittee(value: string) {
    const index = rows.findIndex(r => r.type === 'option' && r.value === value)
    if (index < 0) return
    const list = scrollRef.current
    if (list) {
      const top = computeRowOffsets(rows, HEADER_ROW_HEIGHT, OPTION_ROW_HEIGHT)[index]
      const pinned = rows.some(r => r.type === 'header') ? HEADER_ROW_HEIGHT : 0
      if (top < list.scrollTop + pinned) list.scrollTop = top - pinned
      else if (top + OPTION_ROW_HEIGHT > list.scrollTop + list.clientHeight) list.scrollTop = top + OPTION_ROW_HEIGHT - list.clientHeight
    }
    const box = committeeBox(value)
    if (box) box.focus({ preventScroll: true })
    else pendingFocus.current = value
  }

  function handleMenuKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Escape') {
      e.preventDefault()
      setOpen(false)
      triggerRef.current?.focus()
      return
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    // The arrow keys visit the two scope radios, then each committee the search leaves, whether its row is rendered or not.
    const radios = Array.from(menuRef.current?.querySelectorAll<HTMLInputElement>('input[type="radio"]') ?? [])
    const values = rows.flatMap(r => r.type === 'option' ? [r.value] : [])
    const total = radios.length + values.length
    if (total === 0) return
    e.preventDefault()
    const active = document.activeElement as HTMLElement | null
    const committee = active?.dataset.committee
    const at = radios.indexOf(active as HTMLInputElement) >= 0
      ? radios.indexOf(active as HTMLInputElement)
      : committee !== undefined && values.includes(committee) ? radios.length + values.indexOf(committee) : -1
    const next = e.key === 'ArrowDown' ? (at + 1) % total : at < 0 ? total - 1 : (at - 1 + total) % total
    if (next < radios.length) radios[next].focus()
    else focusCommittee(values[next - radios.length])
  }

  function toggle(value: string) {
    onChange(selected.includes(value) ? selected.filter(v => v !== value) : [...selected, value])
  }

  const hasSelection = selected.length > 0
  return (
    // The arrow keys and Escape are handled here, around the trigger and the menu, since the menu is a group.
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions
    <div ref={ref} style={{ position: 'relative' }} onKeyDown={e => { if (open) handleMenuKeyDown(e) }}>
      <button
        ref={triggerRef}
        onClick={() => setOpen(o => !o)}
        style={{
          fontSize: fontSize.sm, padding: '6px 10px', borderRadius: radius.md, cursor: 'pointer',
          display: 'flex', alignItems: 'center', gap: 5, whiteSpace: 'nowrap',
          background: hasSelection ? color.bgInfo : color.white,
          color: hasSelection ? color.linkBlue : color.textSlate,
          border: `1px solid ${hasSelection ? color.tagBorderBlue : color.borderDefault}`,
          fontWeight: hasSelection ? fontWeight.medium : fontWeight.normal,
        }}
      >
        {hasSelection ? `${label} (${selected.length})` : label}
        <svg width="10" height="6" viewBox="0 0 10 6" fill="none" aria-hidden="true">
          <path d={open ? 'M1 5l4-4 4 4' : 'M1 1l4 4 4-4'} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div
          ref={menuRef}
          role="group"
          aria-label={label}
          style={{
            position: 'absolute', top: 'calc(100% + 4px)', zIndex: 300,
            ...(menuAlign === 'right' ? { right: 0 } : { left: 0 }),
            background: color.white, border: `1px solid ${color.borderDefault}`, borderRadius: radius.lg,
            width: MENU_WIDTH, maxWidth: '90vw', maxHeight: LIST_HEIGHT + CHROME_HEIGHT,
            boxShadow: shadow.md, display: 'flex', flexDirection: 'column',
          }}
        >
          <div style={{ padding: '8px 10px', borderBottom: `1px solid ${color.borderDefault}`, flex: '0 0 auto' }}>
            <input
              type="text"
              aria-label="Search committees"
              placeholder="Search committees…"
              value={search}
              onChange={e => { pendingFocus.current = null; setSearch(e.target.value) }}
              style={{
                width: '100%', boxSizing: 'border-box', fontSize: fontSize.sm, padding: '6px 10px',
                border: `1px solid ${color.borderDefault}`, borderRadius: radius.md,
              }}
            />
          </div>
          <CommitteeScopeSwitch scope={scope} onScopeChange={onScopeChange} name="committee-scope-desktop" style={{ borderBottom: `1px solid ${color.borderDefault}` }} />
          {rows.length === 0 ? (
            <div style={{ padding: '16px 12px', fontSize: fontSize.sm, color: color.textMuted }}>
              {search.trim() ? <>No committees match &ldquo;{search.trim()}&rdquo;.</> : 'No committees.'}
            </div>
          ) : (
            <div
              ref={scrollRef}
              data-testid="committee-options"
              style={{ flex: '1 1 auto', minHeight: 0, overflowX: 'hidden', overflowY: 'auto', position: 'relative' }}
            >
              <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
                {virtualizer.getVirtualItems().map(virtualRow => {
                  const row = rows[virtualRow.index]
                  const sticky = activeStickyIndex === virtualRow.index
                  return (
                    <div key={virtualRow.key} data-index={virtualRow.index} style={getRowWrapperStyle(virtualRow.start, sticky, pushOffset)}>
                      {row.type === 'header' ? (
                        <StickyGroupHeader label={row.label} height={HEADER_ROW_HEIGHT} stuck={sticky && stuck} pushOffset={pushOffset} />
                      ) : (
                        <label style={{
                          height: OPTION_ROW_HEIGHT, boxSizing: 'border-box',
                          display: 'flex', alignItems: 'center', gap: 8, padding: '0 12px', minWidth: 0,
                          cursor: 'pointer', fontSize: fontSize.sm,
                          color: selected.includes(row.value) ? color.linkBlue : color.textSlate,
                          background: selected.includes(row.value) ? color.bgInfo : color.white,
                        }}>
                          <input
                            type="checkbox"
                            data-committee={row.value}
                            checked={selected.includes(row.value)}
                            onChange={() => toggle(row.value)}
                            style={{ margin: 0, accentColor: color.accentBlue, flexShrink: 0 }}
                          />
                          {/* One line, cut off with an ellipsis, as the Subject menu does: a wrapped name would outgrow
                              the fixed row height. `minWidth: 0` lets the name shrink so the ellipsis applies. */}
                          <span
                            title={row.label}
                            style={{ flex: '1 1 auto', minWidth: 0, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}
                          >
                            {row.label}
                          </span>
                          <CountBadge count={row.count ?? 0} />
                        </label>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
