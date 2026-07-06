import { apiFetch } from '../lib/api'
import { POSITION_COLORS } from '../lib/chipStyles'
import { color, fontSize, fontWeight, radius } from '../styles/tokens'

const NO_POSITION = { bg: color.white, color: color.textMuted, border: color.borderDefault }

function ChevronDown({ color }: { color: string }) {
  return (
    <svg width="10" height="6" viewBox="0 0 10 6" fill="none" style={{ display: 'block' }}>
      <path d="M1 1l4 4 4-4" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
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

  return (
    <div style={{ position: 'relative', display: 'inline-flex' }}>
      <select
        value={current ?? ''}
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        onChange={(e) => {
          e.stopPropagation()
          const p = e.target.value === '' ? null : e.target.value
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
          fontSize: fontSize.sm, fontWeight: fontWeight.semibold,
          padding: '3px 22px 3px 10px', borderRadius: radius.sm,
          border: `1px solid ${c.border}`, background: c.bg, color: c.color,
          cursor: 'pointer',
          outline: isFiltered ? `2px solid ${color.accentBlue}` : 'none',
          outlineOffset: 2,
        }}
      >
        <option value="">Not set</option>
        {options.map((opt) => <option key={opt} value={opt}>{opt}</option>)}
      </select>
      <span style={{
        position: 'absolute', right: 7, top: '50%', transform: 'translateY(-50%)',
        pointerEvents: 'none', display: 'flex', alignItems: 'center',
      }}>
        <ChevronDown color={c.color} />
      </span>
    </div>
  )
}
