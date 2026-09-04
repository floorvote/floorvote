import { useState, useRef, useEffect } from 'react'
import { color, radius, fontSize, fontWeight, shadow } from '../../styles/tokens'
import { useDismissOnOutsideClick } from '../../hooks/useDismissOnOutsideClick'
import { normalizeViewQuery } from '../../lib/savedViews'
import { VIEW_STYLE } from '../../../../shared/viewStyle'

export function SaveViewButton({
  currentSearch, onSave,
}: {
  currentSearch: string
  onSave: (name: string) => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [saving, setSaving] = useState(false)
  const ref = useDismissOnOutsideClick(open, () => setOpen(false))
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) {
      inputRef.current?.focus()
    }
  }, [open])

  // Count what is actually being captured, so the summary can say it. Uses the
  // same normalization the divergence check uses (view and page params are
  // excluded from both), but additionally drops sort/dir from the count only —
  // they're stored with the view but aren't filters, so they shouldn't inflate
  // "Saves the N filters applied now."
  const filterCount = [...new URLSearchParams(normalizeViewQuery(currentSearch))]
    .filter(([key]) => key !== 'sort' && key !== 'dir').length

  async function commit() {
    const trimmed = name.trim()
    if (!trimmed || saving) return
    setSaving(true)
    try {
      await onSave(trimmed)
      setOpen(false)
      setName('')
    } catch {
      // Leave the popover open so the user can retry — the error itself is
      // surfaced through BillList's page-level error state.
    } finally {
      setSaving(false)
    }
  }

  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          fontFamily: 'inherit', fontSize: fontSize.sm, padding: '3px 10px',
          // VIEW_STYLE, not the filter blue's tagBorderBlue/bgInfo/linkBlue:
          // saving a view is a views-layer action, distinct from "a filter is on."
          border: `1px solid ${VIEW_STYLE.border}`, borderRadius: radius.md,
          background: VIEW_STYLE.bg, color: VIEW_STYLE.text, cursor: 'pointer', whiteSpace: 'nowrap',
        }}
      >
        Save as view
      </button>
      {open && (
        <div
          style={{
            position: 'absolute', top: 'calc(100% + 4px)', left: 0, zIndex: 300,
            background: color.white, border: `1px solid ${color.borderDefault}`,
            borderRadius: radius.lg, padding: 12, minWidth: 258, boxShadow: shadow.md,
          }}
        >
          <p style={{
            margin: '0 0 6px', fontSize: fontSize.xs, fontWeight: fontWeight.semibold,
            letterSpacing: '0.07em', textTransform: 'uppercase', color: color.textMuted,
          }}>
            Name this view
          </p>
          <input
            ref={inputRef}
            aria-label="View name"
            value={name}
            onChange={e => setName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') commit() }}
            style={{
              width: '100%', boxSizing: 'border-box', fontFamily: 'inherit', fontSize: fontSize.sm,
              padding: '4px 8px', border: `1px solid ${color.accentBlue}`,
              borderRadius: radius.sm, color: color.textPrimary,
            }}
          />
          <p style={{
            margin: '9px 0 0', paddingTop: 9, borderTop: `1px solid ${color.borderDefault}`,
            fontSize: fontSize.sm, color: color.textSecondary, lineHeight: 1.5,
          }}>
            Saves the {filterCount} {filterCount === 1 ? 'filter' : 'filters'} applied now.
            Everyone in your organization will see it beside the page title.
          </p>
          <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', marginTop: 11 }}>
            <button
              onClick={() => setOpen(false)}
              style={{
                fontFamily: 'inherit', fontSize: fontSize.xs, padding: '3px 9px', borderRadius: radius.sm,
                border: `1px solid ${color.borderDefault}`, background: color.white,
                color: color.textSecondary, cursor: 'pointer',
              }}
            >
              Cancel
            </button>
            <button
              onClick={commit}
              style={{
                fontFamily: 'inherit', fontSize: fontSize.xs, padding: '3px 9px', borderRadius: radius.sm,
                border: `1px solid ${color.billBadgeNavy}`, background: color.billBadgeNavy,
                color: color.white, fontWeight: fontWeight.semibold, cursor: 'pointer',
              }}
            >
              Save view
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
