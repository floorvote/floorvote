import { useId } from 'react'
import { apiFetch } from '../lib/api'
import { POSITION_COLORS } from '../lib/chipStyles'
import { color, fontSize, fontWeight, radius } from '../styles/tokens'

// The value of the menu's empty choice ("Not set"), and so the select's value while no position is set. The open menu
// marks it as the current choice and the arrow keys move from it to the first position. (A sentinel, not a word like
// 'none', which a position vocabulary could contain.)
const CLEAR = '__none__'
const NO_POSITION = { bg: color.white, color: color.textMuted, border: color.borderDefault }

function ChevronDown({ color }: { color: string }) {
  return (
    <svg width="10" height="6" viewBox="0 0 10 6" fill="none" style={{ display: 'block' }}>
      <path d="M1 1l4 4 4-4" style={{ stroke: color }} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

interface CompactPositionSelectProps {
  billId: string
  current: string | null
  options: string[]
  onChange: (p: string | null) => void
  size?: 'sm' | 'lg'
  isFiltered?: boolean
}

export function CompactPositionSelect({ billId, current, options, onChange, isFiltered }: CompactPositionSelectProps) {
  const c = current ? (POSITION_COLORS[current] ?? NO_POSITION) : NO_POSITION
  const empty = current === null
  const labelId = useId()
  const optionStyle = { color: c.color, WebkitTextFillColor: c.color }

  return (
    // "Set position" is drawn over the select while no position is set (the select sits on its real empty choice, "Not set",
    // with its own text transparent), in the same grid cell so the chip is as wide as the wider of the two.
    <div style={{ position: 'relative', display: 'inline-grid' }}>
      <select
        aria-label="Position"
        aria-describedby={empty ? labelId : undefined}
        value={current ?? CLEAR}
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        onChange={(e) => {
          e.stopPropagation()
          const p = e.target.value === CLEAR ? null : e.target.value
          // "Not set" on a bill that has no position changes nothing: no request.
          if (p === null && empty) return
          if (p !== null) {
            apiFetch(`/bills/${billId}/position`, { method: 'POST', body: JSON.stringify({ position: p }) })
              .then(() => onChange(p))
          } else {
            apiFetch(`/bills/${billId}/position`, { method: 'DELETE' })
              .then(() => onChange(null))
          }
        }}
        style={{
          WebkitAppearance: 'none', appearance: 'none',
          gridArea: '1 / 1', width: '100%',
          fontSize: fontSize.sm, fontWeight: fontWeight.semibold,
          padding: '3px 22px 3px 10px', borderRadius: radius.sm,
          border: `1px solid ${c.border}`, background: c.bg, color: c.color,
          cursor: 'pointer',
          // The label stands in for the select's own text while empty. The options carry their own colour, since some
          // browsers draw the open menu in the select's.
          ...(empty ? { WebkitTextFillColor: 'transparent' } : {}),
          outline: isFiltered ? `2px solid ${color.accentBlue}` : 'none',
          outlineOffset: 2,
        }}
      >
        <option value={CLEAR} style={optionStyle}>Not set</option>
        {options.map((opt) => <option key={opt} value={opt} style={optionStyle}>{opt}</option>)}
      </select>
      {empty && (
        <span
          id={labelId}
          data-closed-label=""
          aria-hidden="true"
          style={{
            gridArea: '1 / 1', pointerEvents: 'none', whiteSpace: 'nowrap', fontFamily: 'inherit',
            fontSize: fontSize.sm, fontWeight: fontWeight.semibold, padding: '3px 22px 3px 10px',
            border: '1px solid transparent', color: c.color, textAlign: 'left',
          }}
        >
          Set position
        </span>
      )}
      <span style={{
        position: 'absolute', right: 7, top: '50%', transform: 'translateY(-50%)',
        pointerEvents: 'none', display: 'flex', alignItems: 'center',
      }}>
        <ChevronDown color={c.color} />
      </span>
    </div>
  )
}
