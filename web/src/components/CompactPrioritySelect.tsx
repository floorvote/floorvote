import { apiFetch } from '../lib/api'
import { PRIORITY_COLORS } from '../lib/chipStyles'
import { color, radius as radiusTokens, fontWeight } from '../styles/tokens'

const NO_PRIORITY = { fill: color.white, text: color.textMuted, dot: color.borderDefault, label: '' }
// An untriaged new match: the same control in amber.
const NEW_MATCH = { fill: color.bgAmberPriority, text: color.textAmberDark }
const DISMISS = 'dismiss'

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
}

export function CompactPrioritySelect({ billId, current, onChange, isFiltered, mini, placeholder = 'Set priority', newMatch, onDismiss }: CompactPrioritySelectProps) {
  const amber = !!newMatch && !current
  const c = current ? PRIORITY_COLORS[current] : amber ? NEW_MATCH : NO_PRIORITY
  const borderColor = current ? 'transparent' : amber ? color.borderAmber : color.borderDefault

  const fs = mini ? 10 : 12
  const pad = mini ? '2px 18px 2px 6px' : '3px 22px 3px 10px'
  const borderRad = mini ? radiusTokens.sm : radiusTokens.sm
  const arrowRight = mini ? 5 : 7

  return (
    <div style={{ position: 'relative', display: 'inline-flex' }}>
      <select
        aria-label={amber ? 'Priority (new match: set a priority or dismiss)' : 'Priority'}
        value={current ?? ''}
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        onChange={(e) => {
          e.stopPropagation()
          if (e.target.value === DISMISS) {
            // Triage with no priority. A failed request leaves the control as it
            // was, still a new match, so the admin can try again.
            apiFetch(`/bills/${billId}/triage-dismiss`, { method: 'PATCH' }).then(() => onDismiss?.()).catch(() => {})
            return
          }
          const p = e.target.value === '' ? null : e.target.value as 'high' | 'medium' | 'low'
          apiFetch<{ priority: 'high' | 'medium' | 'low' | null; promoted?: boolean }>(`/bills/${billId}/priority`, { method: 'PATCH', body: JSON.stringify({ priority: p }) })
            .then((result) => onChange(p, result))
        }}
        style={{
          WebkitAppearance: 'none', appearance: 'none',
          fontSize: fs, fontWeight: fontWeight.semibold,
          padding: pad, borderRadius: borderRad,
          border: `1px solid ${borderColor}`, background: c.fill, color: c.text,
          cursor: 'pointer',
          outline: isFiltered ? `2px solid ${color.accentBlue}` : 'none',
          outlineOffset: 2,
        }}
      >
        <option value="">{amber ? 'New · Set priority' : placeholder}</option>
        <option value="high">High Priority</option>
        <option value="medium">Medium Priority</option>
        <option value="low">Low Priority</option>
        {amber && <option value={DISMISS}>Dismiss (reviewed, no priority)</option>}
      </select>
      <span style={{
        position: 'absolute', right: arrowRight, top: '50%', transform: 'translateY(-50%)',
        pointerEvents: 'none', display: 'flex', alignItems: 'center',
      }}>
        <ChevronDown size={mini ? 8 : 10} color={c.text} />
      </span>
    </div>
  )
}
