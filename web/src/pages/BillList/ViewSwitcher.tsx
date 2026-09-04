import { useState, useEffect, useRef } from 'react'
import { color, radius, fontSize, fontWeight, shadow } from '../../styles/tokens'
import { useDismissOnOutsideClick } from '../../hooks/useDismissOnOutsideClick'
import { findActiveView } from '../../lib/savedViews'
import { apiFetch } from '../../lib/api'
import { countBadge } from '../../lib/chipStyles'

export type SavedView = { id: string; name: string; query: string }

// Sentinel key for the "All bills" row's count, distinct from any view id.
const ALL_BILLS_KEY = '__all_bills__'

// Count badge for a view row — same COUNT_BADGE treatment FilterDropdown uses
// (see chipStyles' countBadge()), but with three states instead of one: a
// loaded count (a number), an in-flight count (renders a neutral placeholder,
// never 0 — a wrong zero reads as "no matches"), or a failed count (renders
// nothing at all, rather than a misleading number).
function ViewCountBadge({ count, failed }: { count: number | undefined; failed: boolean }) {
  if (failed) return null
  return (
    <span style={{ ...countBadge(), marginLeft: 'auto', flexShrink: 0 }}>
      {count === undefined ? '…' : count.toLocaleString()}
    </span>
  )
}

export function ViewSwitcher({
  views, currentSearch, isAdmin, onApply, onRename, onDelete,
}: {
  views: SavedView[]
  currentSearch: string
  isAdmin: boolean
  onApply: (view: SavedView | null) => void
  onRename: (id: string, name: string) => void | Promise<void>
  onDelete: (id: string) => void | Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [draftName, setDraftName] = useState('')
  const [confirmingId, setConfirmingId] = useState<string | null>(null)
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  // Rename/Delete must also be reachable without a mouse — mouseenter never
  // fires on touch, and tabbing to a row doesn't set hoveredId. onFocus/onBlur
  // on the row wrapper catch focus landing on (or leaving) any descendant,
  // since React's focus events bubble.
  const [focusedId, setFocusedId] = useState<string | null>(null)
  const ref = useDismissOnOutsideClick(open, () => setOpen(false))

  // Closing the menu abandons any in-progress rename or delete confirm, so
  // reopening never resumes a half-finished destructive action.
  useEffect(() => {
    if (open) return
    setRenamingId(null)
    setConfirmingId(null)
  }, [open])

  // Match counts, keyed by view id (or ALL_BILLS_KEY for "All bills"). Fetched
  // lazily on menu-open rather than on page load: most page loads never open
  // this menu, and each count is its own /bills query, so the cost should only
  // land when someone actually looks. fetchedKeysRef persists for the life of
  // the component, so reopening the menu never refetches an already-resolved
  // (or already-failed) count.
  const [viewCounts, setViewCounts] = useState<Record<string, number>>({})
  const [failedCounts, setFailedCounts] = useState<Set<string>>(new Set())
  const fetchedKeysRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    if (!open) return
    const targets: Array<{ key: string; query: string }> = [
      { key: ALL_BILLS_KEY, query: '' },
      ...views.map(v => ({ key: v.id, query: v.query })),
    ]
    for (const { key, query } of targets) {
      if (fetchedKeysRef.current.has(key)) continue
      fetchedKeysRef.current.add(key)
      // pageSize=1 so this costs a count, not a page of rows — each view's
      // stored query is already a valid /bills filter string.
      const params = new URLSearchParams(query)
      params.set('page', '1')
      params.set('pageSize', '1')
      apiFetch<{ pagination: { total: number } }>(`/bills?${params.toString()}`)
        .then(data => setViewCounts(prev => ({ ...prev, [key]: data.pagination.total })))
        .catch(() => setFailedCounts(prev => new Set(prev).add(key)))
    }
  }, [open, views])

  // A tenant with no views gets no control at all — the h1 row is unchanged.
  if (views.length === 0) return null

  const active = findActiveView(currentSearch, views)

  // "Views", never "All bills": in the diverged state filters are applied and no
  // view matches, and "All bills" would misdescribe what is on screen.
  const label = active?.name ?? 'Views'

  function beginRename(v: SavedView) {
    setConfirmingId(null)
    setRenamingId(v.id)
    setDraftName(v.name)
  }

  async function commitRename() {
    const next = draftName.trim()
    if (!renamingId || !next) return
    try {
      await onRename(renamingId, next)
      setRenamingId(null)
    } catch {
      // Leave the row in its editing state so the user can see the rename
      // didn't take, instead of closing as though it had succeeded.
    }
  }

  async function commitDelete(id: string) {
    try {
      await onDelete(id)
      setConfirmingId(null)
    } catch {
      // Leave the confirm state open so the user can see the delete didn't
      // take, instead of closing as though it had succeeded.
    }
  }

  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          fontFamily: 'inherit', fontSize: fontSize.base,
          fontWeight: active ? fontWeight.semibold : fontWeight.medium,
          // Amber, not the filter blue: this trigger's color means "a view is
          // applied," a distinct signal from "a filter is on." Resting state
          // stays neutral so a quiet control doesn't imply a view is active.
          color: active ? color.textAmberDark : color.textSecondary,
          background: 'none', border: 'none', cursor: 'pointer',
          padding: '3px 7px', borderRadius: radius.md,
          display: 'inline-flex', alignItems: 'center', gap: 5, whiteSpace: 'nowrap',
        }}
      >
        {label}
        <svg width="10" height="6" viewBox="0 0 10 6" fill="none" aria-hidden="true">
          <path
            d={open ? 'M1 5l4-4 4 4' : 'M1 1l4 4 4-4'}
            stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
          />
        </svg>
      </button>
      {open && (
        <div
          role="group"
          aria-label="Saved views"
          style={{
            position: 'absolute', top: 'calc(100% + 4px)', left: 0, zIndex: 300,
            background: color.white, border: `1px solid ${color.borderDefault}`,
            borderRadius: radius.lg, padding: '4px 0', minWidth: 232, maxHeight: 300, overflowY: 'auto',
            boxShadow: shadow.md,
          }}
        >
          <button
            onClick={() => { onApply(null); setOpen(false) }}
            style={rowStyle(!active)}
          >
            All bills
            <ViewCountBadge count={viewCounts[ALL_BILLS_KEY]} failed={failedCounts.has(ALL_BILLS_KEY)} />
          </button>
          <div style={{ height: 1, background: color.borderDefault, margin: '4px 0' }} />
          {views.map(v => {
            if (renamingId === v.id) {
              return (
                <div key={v.id} style={{ ...rowStyle(false), cursor: 'default', gap: 6 }}>
                  <input
                    aria-label="View name"
                    value={draftName}
                    onChange={e => setDraftName(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') commitRename()
                      if (e.key === 'Escape') setRenamingId(null)
                    }}
                    style={{
                      flex: 1, minWidth: 0, fontFamily: 'inherit', fontSize: fontSize.sm,
                      padding: '3px 7px', border: `1px solid ${color.accentBlue}`,
                      borderRadius: radius.sm, color: color.textPrimary,
                    }}
                  />
                  <button onClick={commitRename} style={smallButtonStyle('primary')}>Save</button>
                </div>
              )
            }
            if (confirmingId === v.id) {
              return (
                <div key={v.id} style={{ ...rowStyle(false), cursor: 'default', background: color.bgDangerSoft, color: color.textDanger }}>
                  <span style={{ flex: 1, minWidth: 0, fontWeight: fontWeight.medium }}>Delete for everyone?</span>
                  <button onClick={() => setConfirmingId(null)} style={smallButtonStyle('cancel')}>Cancel</button>
                  <button onClick={() => { void commitDelete(v.id) }} style={smallButtonStyle('danger')}>Delete</button>
                </div>
              )
            }
            const isActive = active?.id === v.id
            return (
              <div
                key={v.id}
                onMouseEnter={() => setHoveredId(v.id)}
                onMouseLeave={() => setHoveredId(null)}
                onFocus={() => setFocusedId(v.id)}
                onBlur={() => setFocusedId(null)}
                style={{ ...rowStyle(isActive), cursor: 'default' }}
              >
                <button
                  onClick={() => { onApply(v); setOpen(false) }}
                  style={{
                    flex: '1 1 auto', minWidth: 0, textAlign: 'left', background: 'none',
                    border: 'none', padding: 0, cursor: 'pointer', font: 'inherit',
                    color: 'inherit', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}
                >
                  {v.name}
                </button>
                <ViewCountBadge count={viewCounts[v.id]} failed={failedCounts.has(v.id)} />
                {isAdmin && (hoveredId === v.id || focusedId === v.id) && (
                  <span style={{ display: 'flex', gap: 2, flex: 'none' }}>
                    <button onClick={() => beginRename(v)} style={iconButtonStyle}>Rename</button>
                    <button onClick={() => { setRenamingId(null); setConfirmingId(v.id) }} style={iconButtonStyle}>Delete</button>
                  </span>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function rowStyle(selected: boolean): React.CSSProperties {
  return {
    display: 'flex', alignItems: 'center', gap: 8, padding: '7px 12px',
    fontSize: fontSize.sm, width: '100%', textAlign: 'left',
    fontFamily: 'inherit', border: 'none', cursor: 'pointer',
    // Amber, not the filter blue's bgInfo/linkBlue — a selected view row is a
    // distinct signal from "a filter is on." bgAmberPriority/textAmberDark is
    // the same sanctioned amber-chip pairing used elsewhere.
    background: selected ? color.bgAmberPriority : 'transparent',
    color: selected ? color.textAmberDark : color.textSlate,
  }
}

const iconButtonStyle: React.CSSProperties = {
  fontFamily: 'inherit', background: 'none', border: 'none', cursor: 'pointer',
  color: color.textSecondary, fontSize: fontSize.xs, padding: '1px 4px', borderRadius: radius.sm,
}

function smallButtonStyle(kind: 'primary' | 'danger' | 'cancel'): React.CSSProperties {
  const base: React.CSSProperties = {
    fontFamily: 'inherit', fontSize: fontSize.xs, padding: '2px 8px',
    borderRadius: radius.sm, cursor: 'pointer', whiteSpace: 'nowrap',
  }
  if (kind === 'primary') return { ...base, border: `1px solid ${color.billBadgeNavy}`, background: color.billBadgeNavy, color: color.white, fontWeight: fontWeight.semibold }
  if (kind === 'danger') return { ...base, border: `1px solid ${color.borderRedChip}`, background: color.white, color: color.textDanger, fontWeight: fontWeight.semibold }
  return { ...base, border: `1px solid ${color.borderDefault}`, background: color.white, color: color.textSecondary }
}
