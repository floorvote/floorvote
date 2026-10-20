import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { color, radius, fontSize, fontWeight, shadow } from '../../styles/tokens'
import { filterDimensionLabel } from '../../lib/filterDimensions'
import { useMenuAlign } from '../../hooks/useMenuAlign'
import type { CommitteeGroup } from '../../lib/committeeGroups'
import { CountBadge } from './FilterPanel'

export type CommitteeScope = 'current' | 'any'

/** The scope switch's two choices, in the order the menu shows them. */
export const COMMITTEE_SCOPES: ReadonlyArray<{ value: CommitteeScope; label: string }> = [
  { value: 'current', label: 'Current committee' },
  { value: 'any', label: 'Any referral' },
]

/** What the Committee control says on hover. */
export const COMMITTEE_FILTER_HINT = 'Filter by the committee a bill is in now, or any committee it was referred to.'

/** What a procedural committee's tag says on hover. */
export const PROCEDURAL_HINT = 'Routes or schedules bills rather than weighing them, so it can hold many of a session\'s bills.'

/** The tag beside a procedural committee (Rules, Assignments, Calendars). */
export function ProceduralTag() {
  return (
    <span
      title={PROCEDURAL_HINT}
      style={{
        fontSize: fontSize.xs, color: color.textMuted, border: `1px solid ${color.borderDefault}`,
        borderRadius: radius.sm, padding: '0 4px', flexShrink: 0,
      }}
    >
      Procedural
    </span>
  )
}

/** The current committee or any referral, as two radios. */
export function CommitteeScopeSwitch({ scope, onScopeChange, name }: { scope: CommitteeScope; onScopeChange: (scope: CommitteeScope) => void; name: string }) {
  return (
    <div role="radiogroup" aria-label="Match a bill's committee by" style={{ display: 'flex', gap: 12, padding: '7px 12px', fontSize: fontSize.sm, color: color.textSlate }}>
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

/** A control the menu's arrow keys visit. */
const MENU_ITEM = 'input[type="radio"], input[type="checkbox"]'

/**
 * The Committee filter (#471): each committee with its bill count, under its state on a multi-state instance, the
 * procedural ones last and tagged, and a switch between the committee a bill is in now and any committee it was
 * referred to. The options come from `committeeGroups`.
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
  const menuAlign = useMenuAlign(open, triggerRef, menuRef)
  const label = filterDimensionLabel('committee')

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
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLInputElement>(MENU_ITEM) ?? [])
    ;(items.find(i => i.checked) ?? items[0])?.focus()
  }, [open])

  function handleMenuKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Escape') {
      e.preventDefault()
      setOpen(false)
      triggerRef.current?.focus()
      return
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLElement>(MENU_ITEM) ?? [])
    if (items.length === 0) return
    e.preventDefault()
    const at = items.indexOf(document.activeElement as HTMLElement)
    const next = e.key === 'ArrowDown' ? (at + 1) % items.length : (at - 1 + items.length) % items.length
    items[next].focus()
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
            padding: '4px 0', minWidth: 240, maxWidth: 'min(400px, 90vw)', maxHeight: 360, overflowY: 'auto',
            boxShadow: shadow.md,
          }}
        >
          <CommitteeScopeSwitch scope={scope} onScopeChange={onScopeChange} name="committee-scope-desktop" />
          {groups.map(group => (
            <div key={group.state}>
              {showStates && (
                <div style={{ padding: '7px 12px', fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: color.textMuted, background: color.surfaceMuted }}>
                  {group.state}
                </div>
              )}
              {group.options.map(opt => {
                const checked = selected.includes(opt.value)
                return (
                  <label key={opt.value} style={{
                    display: 'flex', alignItems: 'center', gap: 8, padding: '7px 12px', minWidth: 0,
                    cursor: 'pointer', fontSize: fontSize.sm, overflowWrap: 'anywhere',
                    color: checked ? color.linkBlue : color.textSlate,
                    background: checked ? color.bgInfo : 'transparent',
                  }}>
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggle(opt.value)}
                      style={{ margin: 0, accentColor: color.accentBlue, flexShrink: 0 }}
                    />
                    {opt.label}
                    {opt.procedural && <ProceduralTag />}
                    <CountBadge count={opt.count} />
                  </label>
                )
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
