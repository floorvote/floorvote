import React, { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import { color, radius, fontSize, fontWeight, shadow } from '../../styles/tokens'
import { COUNT_BADGE } from '../../lib/chipStyles'
import type { SortColumn, SortDir } from './types'

// Sentinel filter value: "has any value in this dimension" (sparse dimensions only —
// position, custom-field dropdowns). Distinct from "no filter" (empty selection).
export const FILTER_ANY = '__any__'

export function sortDescription(col: SortColumn, posLabel: string, relLabel: string): ReactNode {
  // Hierarchy slots in display order, matching SORT_HIERARCHY in the API
  const HIERARCHY_LABELS: Array<{ key: string; label: string }> = [
    { key: 'year',       label: 'Year' },
    { key: 'priority',   label: 'Priority' },
    { key: 'position',   label: posLabel },
    { key: 'relevance',  label: relLabel },
    { key: 'lastAction', label: 'Last action' },
  ]
  const EXTRA_LABELS: Record<string, string> = {
    status: 'Status',
    bill:   'Bill',
  }

  // Build display order: active column first (if not default), rest follow
  const activeKey = col === 'session' ? 'year' : col  // session and year share a slot
  let ordered = [...HIERARCHY_LABELS]

  if (col !== 'default') {
    const inHierarchy = ordered.findIndex(h => h.key === activeKey)
    if (inHierarchy >= 0) {
      // Move clicked slot to front
      ordered = [ordered[inHierarchy], ...ordered.filter((_, i) => i !== inHierarchy)]
    } else {
      // Prepend extra column
      const extraLabel = EXTRA_LABELS[col] ?? col
      ordered = [{ key: col, label: extraLabel }, ...ordered]
    }
  }

  return (
    <span>
      {'Sorted by: '}
      {ordered.map((item, i) => {
        const isActive = col !== 'default' && item.key === activeKey
        return (
          <React.Fragment key={item.key}>
            {i > 0 && ' → '}
            {isActive
              ? <span style={{ color: color.linkBlue }}>{item.label}</span>
              : item.label}
          </React.Fragment>
        )
      })}
    </span>
  )
}

export function SortHeader({
  col, label, current, dir, onSort, naturalDir = 'desc',
}: { col: SortColumn; label: string; current: SortColumn; dir: SortDir; onSort: (col: SortColumn) => void; naturalDir?: SortDir }) {
  const active = current === col
  return (
    <button
      onClick={() => onSort(col)}
      style={{
        background: 'none', border: 'none', cursor: 'pointer', padding: 0,
        fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: active ? color.linkBlue : color.textMuted,
        letterSpacing: '0.05em', textTransform: 'uppercase', display: 'flex',
        alignItems: 'center', gap: 3, textAlign: 'left', whiteSpace: 'nowrap',
      }}
    >
      {label}
      <span style={{ fontSize: fontSize.xs, opacity: active ? 1 : 0.4 }}>
        {active ? (dir === naturalDir ? '▼' : '▲') : '▲▼'}
      </span>
    </button>
  )
}

export function CountBadge({ count }: { count: number }) {
  return (
    <span style={{ ...COUNT_BADGE, marginLeft: 'auto' }}>
      {count.toLocaleString()}
    </span>
  )
}

export function FilterDropdown({
  placeholder,
  options,
  selected,
  onChange,
  multi = false,
  counts,
  anyIsFilter = false,
  anyLabel = 'Any',
}: {
  placeholder: string
  options: { value: string; label?: string }[]
  selected: string[]
  onChange: (v: string[]) => void
  multi?: boolean
  counts?: Record<string, number>
  /** When true, the top "Any" row is a real "has any value" filter (sparse dimensions)
   *  with its own honest count. When false, it's an unchecked "clear" affordance. */
  anyIsFilter?: boolean
  anyLabel?: string
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  // Move focus into the menu as soon as it opens, regardless of how it was
  // opened. A mouse click on the trigger leaves focus on the trigger button,
  // so arrow keys never reach handleMenuKeyDown below and instead scroll the
  // surrounding bills table (R4 follow-up bug report — the earlier fix mistakenly
  // targeted Picker.tsx instead of this component). Focusing the checked option
  // (or the first option when nothing is selected) as soon as the menu mounts
  // means arrow-key navigation works immediately no matter how it was opened.
  // Mirrors the same pattern in components/Picker.tsx.
  useEffect(() => {
    if (!open) return
    const menu = menuRef.current
    if (!menu) return
    const items = Array.from(menu.querySelectorAll<HTMLInputElement>('input[type="radio"], input[type="checkbox"]'))
    if (items.length === 0) return
    const checked = items.find(el => el.checked)
    ;(checked ?? items[0]).focus()
  }, [open])

  // Moves focus back to the trigger button after Escape closes the menu.
  function focusTrigger() {
    triggerRef.current?.focus()
  }

  function getOptionEls(): HTMLInputElement[] {
    const menu = menuRef.current
    if (!menu) return []
    return Array.from(menu.querySelectorAll<HTMLInputElement>('input[type="radio"], input[type="checkbox"]'))
  }

  function handleMenuKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Escape') {
      e.preventDefault()
      setOpen(false)
      focusTrigger()
      return
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return
    const items = getOptionEls()
    if (items.length === 0) return
    const activeIndex = items.indexOf(document.activeElement as HTMLInputElement)
    e.preventDefault()
    let nextIndex: number
    if (e.key === 'Home') nextIndex = 0
    else if (e.key === 'End') nextIndex = items.length - 1
    // Wrap around at the ends, matching Picker's radiogroup/menu convention.
    else if (e.key === 'ArrowDown') nextIndex = activeIndex < 0 ? 0 : (activeIndex + 1) % items.length
    else nextIndex = activeIndex < 0 ? items.length - 1 : (activeIndex - 1 + items.length) % items.length
    items[nextIndex].focus()
  }

  const anyActive = selected.includes(FILTER_ANY)
  const buttonLabel = selected.length === 0
    ? placeholder
    : anyActive
      ? `${placeholder}: ${anyLabel}`
      : multi
        ? `${placeholder} (${selected.length})`
        : (options.find(o => o.value === selected[0])?.label ?? selected[0])

  const hasSelection = selected.length > 0

  // "Any" = "has any value in this dimension" — shown only for sparse dimensions
  // (position, priority, tag, custom-field dropdowns). Always-present dimensions have
  // no top row at all; an empty selection is the implicit "no filter" / show-all.
  function chooseAny() {
    // Toggle: checking selects the has-value filter; unchecking clears it (back to no filter).
    onChange(anyActive ? selected.filter(v => v !== FILTER_ANY) : [FILTER_ANY])
  }
  function toggle(value: string) {
    const base = selected.filter(v => v !== FILTER_ANY) // picking a specific value clears "Any"
    if (multi) {
      onChange(base.includes(value) ? base.filter(v => v !== value) : [...base, value])
    } else {
      onChange(base.includes(value) ? [] : [value])
    }
  }

  return (
    <div ref={ref} style={{ position: 'relative' }}>
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
        {buttonLabel}
        <svg width="10" height="6" viewBox="0 0 10 6" fill="none">
          <path d={open ? 'M1 5l4-4 4 4' : 'M1 1l4 4 4-4'} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div
          ref={menuRef}
          role={multi ? 'group' : 'radiogroup'}
          aria-label={placeholder}
          onKeyDown={handleMenuKeyDown}
          style={{
            position: 'absolute', top: 'calc(100% + 4px)', left: 0, zIndex: 300,
            background: color.white, border: `1px solid ${color.borderDefault}`, borderRadius: radius.lg,
            padding: '4px 0', minWidth: 180, maxHeight: 300, overflowY: 'auto',
            boxShadow: shadow.md,
          }}
        >
          {anyIsFilter && (
            <label style={{
              display: 'flex', alignItems: 'center', gap: 8, padding: '7px 12px',
              cursor: 'pointer', fontSize: fontSize.sm,
              color: anyActive ? color.linkBlue : color.textSlate,
              background: anyActive ? color.bgInfo : 'transparent',
            }}>
              <input
                type={multi ? 'checkbox' : 'radio'}
                checked={anyActive}
                onChange={chooseAny}
                style={{ margin: 0, accentColor: color.accentBlue }}
              />
              {anyLabel}
              {counts && <CountBadge count={counts[FILTER_ANY] ?? 0} />}
            </label>
          )}
          {options.map(opt => {
            const checked = selected.includes(opt.value)
            return (
              <label key={opt.value} style={{
                display: 'flex', alignItems: 'center', gap: 8, padding: '7px 12px',
                cursor: 'pointer', fontSize: fontSize.sm,
                color: checked ? color.linkBlue : color.textSlate,
                background: checked ? color.bgInfo : 'transparent',
              }}>
                <input
                  type={multi ? 'checkbox' : 'radio'}
                  checked={checked}
                  onChange={() => toggle(opt.value)}
                  style={{ margin: 0, accentColor: color.accentBlue }}
                />
                {opt.label ?? opt.value}
                {counts && <CountBadge count={counts[opt.value] ?? 0} />}
              </label>
            )
          })}
        </div>
      )}
    </div>
  )
}

export type ChipColor = 'gray' | 'blue' | 'red' | 'green' | 'purple'

export function ActiveChip({ label, onRemove, color: chipColor }: { label: string; onRemove: () => void; color: ChipColor }) {
  const styles: Record<ChipColor, { bg: string; text: string; border: string }> = {
    gray:   { bg: color.surfaceSubtle, text: color.textSecondary, border: color.borderDefault },
    blue:   { bg: color.bgInfo, text: color.tagTextBlue, border: color.tagBorderBlue },
    red:    { bg: color.bgRedPriority, text: color.textDanger, border: color.borderRedChip },
    green:  { bg: color.bgSuccessChip, text: color.textSuccessDark, border: color.borderGreenChip },
    purple: { bg: color.bgVioletChip, text: color.textVioletChip, border: color.borderPurpleChip },
  }
  const s = styles[chipColor]
  return (
    <span style={{
      fontSize: fontSize.sm, padding: '2px 4px 2px 8px', borderRadius: radius.sm,
      background: s.bg, color: s.text, border: `1px solid ${s.border}`,
      display: 'inline-flex', alignItems: 'center', gap: 3,
    }}>
      {label}
      <button
        onClick={onRemove}
        style={{
          background: 'none', border: 'none', padding: '0 2px', cursor: 'pointer',
          color: s.text, lineHeight: 1, fontSize: fontSize.base, display: 'flex', alignItems: 'center',
        }}
      >
        ×
      </button>
    </span>
  )
}
