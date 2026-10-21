import { useRef, useState } from 'react'
import { apiFetch } from '../lib/api'
import { PRIORITY_COLORS } from '../lib/chipStyles'
import { color, radius as radiusTokens, fontWeight, fontSize } from '../styles/tokens'

const NO_PRIORITY = { fill: color.white, text: color.textMuted, dot: color.borderDefault, label: '' }
// An untriaged new match: the same control in amber.
const NEW_MATCH = { fill: color.bgAmberPriority, text: color.textAmberDark }
const DISMISS = 'dismiss'
const PRIORITY_LABELS = { high: 'High Priority', medium: 'Medium Priority', low: 'Low Priority' } as const

function ChevronDown({ size = 10, color }: { size?: number; color: string }) {
  const h = Math.round(size * 0.6)
  return (
    <svg width={size} height={h} viewBox="0 0 10 6" fill="none" style={{ display: 'block' }}>
      <path d="M1 1l4 4 4-4" style={{ stroke: color }} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

interface CompactPrioritySelectProps {
  billId: string
  current: 'high' | 'medium' | 'low' | null
  onChange: (p: 'high' | 'medium' | 'low' | null, result?: { promoted?: boolean }) => void
  isFiltered?: boolean
  mini?: boolean
  placeholder?: string
  /**
   * An untriaged new match (see lib/newMatch.ts). While no priority is set, the
   * control is amber, reads "New · Set priority", and its menu ends with
   * "Dismiss (reviewed, no priority)".
   */
  newMatch?: boolean
  /** Called after Dismiss has triaged the bill. Only reachable on a new match. */
  onDismiss?: () => void
  /**
   * Which edge of the control the failure message ("Couldn't save priority...") hangs from. The message is wider
   * than the control, so a control at the right edge of a card or the sidebar sets 'right' to keep it inside.
   */
  errorAlign?: 'left' | 'right'
}

export function CompactPrioritySelect({ billId, current, onChange, isFiltered, mini, placeholder = 'Set priority', newMatch, onDismiss, errorAlign = 'left' }: CompactPrioritySelectProps) {
  // The message for the last failed request (a save or a Dismiss), shown until the next change.
  const [error, setError] = useState<string | null>(null)
  // The id of the latest priority save. Only the latest one may report: a slow earlier save that settles after a later one
  // must not call onChange with the older value or show an error about a value the later save replaced.
  const latestSave = useRef(0)
  const amber = !!newMatch && !current
  const c = current ? PRIORITY_COLORS[current] : amber ? NEW_MATCH : NO_PRIORITY
  const borderColor = current ? 'transparent' : amber ? color.borderAmber : color.borderDefault

  const fs = mini ? 10 : 12
  const pad = mini ? '2px 18px 2px 6px' : '3px 22px 3px 10px'
  const borderRad = mini ? radiusTokens.sm : radiusTokens.sm
  const arrowRight = mini ? 5 : 7
  const selectedLabel = current ? PRIORITY_LABELS[current] : amber ? 'New · Set priority' : placeholder

  // A native <select> is as wide as its widest option, so "Dismiss (reviewed, no priority)" would stretch the closed
  // chip past the bill table's priority column. A hidden copy of the selected label sets the width instead, and the
  // select (width 0, min-width 100%) fills it. The open menu is the browser's and stays as wide as its options.
  return (
    <div style={{ position: 'relative', display: 'inline-grid' }}>
      <span
        data-testid="priority-select-sizer"
        aria-hidden="true"
        style={{
          gridArea: '1 / 1', visibility: 'hidden', pointerEvents: 'none', whiteSpace: 'nowrap', fontFamily: 'inherit',
          fontSize: fs, fontWeight: fontWeight.semibold, padding: pad, border: '1px solid transparent',
        }}
      >
        {selectedLabel}
      </span>
      <select
        aria-label={amber ? 'Priority (new match: set a priority or dismiss)' : 'Priority'}
        value={current ?? ''}
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        onChange={(e) => {
          e.stopPropagation()
          setError(null)
          if (e.target.value === DISMISS) {
            // Triage with no priority. A failed request leaves the control as it
            // was, still a new match, so the admin can try again.
            apiFetch(`/bills/${billId}/triage-dismiss`, { method: 'PATCH' }).then(() => onDismiss?.()).catch(() => setError("Couldn't dismiss. Try again."))
            return
          }
          const p = e.target.value === '' ? null : e.target.value as 'high' | 'medium' | 'low'
          const id = ++latestSave.current
          apiFetch<{ priority: 'high' | 'medium' | 'low' | null; promoted?: boolean }>(`/bills/${billId}/priority`, { method: 'PATCH', body: JSON.stringify({ priority: p }) })
            // A failed save leaves the control on the saved priority (the select is controlled) and says so.
            // The rejection handler is the second argument, not a catch, so an error thrown by onChange is not swallowed.
            .then(
              (result) => { if (id === latestSave.current) onChange(p, result) },
              () => { if (id === latestSave.current) setError("Couldn't save priority. Try again.") },
            )
        }}
        style={{
          WebkitAppearance: 'none', appearance: 'none',
          gridArea: '1 / 1', width: 0, minWidth: '100%', fontFamily: 'inherit',
          fontSize: fs, fontWeight: fontWeight.semibold,
          padding: pad, borderRadius: borderRad,
          border: `1px solid ${borderColor}`, background: c.fill, color: c.text,
          cursor: 'pointer',
          outline: isFiltered ? `2px solid ${color.accentBlue}` : 'none',
          outlineOffset: 2,
        }}
      >
        <option value="">{amber ? 'New · Set priority' : placeholder}</option>
        <option value="high">{PRIORITY_LABELS.high}</option>
        <option value="medium">{PRIORITY_LABELS.medium}</option>
        <option value="low">{PRIORITY_LABELS.low}</option>
        {amber && <option value={DISMISS}>Dismiss (reviewed, no priority)</option>}
      </select>
      <span style={{
        position: 'absolute', right: arrowRight, top: '50%', transform: 'translateY(-50%)',
        pointerEvents: 'none', display: 'flex', alignItems: 'center',
      }}>
        <ChevronDown size={mini ? 8 : 10} color={c.text} />
      </span>
      {error && (
        <span role="alert" style={{
          position: 'absolute', top: '100%', ...(errorAlign === 'right' ? { right: 0 } : { left: 0 }), marginTop: 2, whiteSpace: 'nowrap', zIndex: 1,
          fontSize: fontSize.xs, color: color.textErrorRed,
        }}>
          {error}
        </span>
      )}
    </div>
  )
}
