import { PRIORITY_COLORS } from '../lib/chipStyles'
import { fontSize, fontWeight, radius } from '../styles/tokens'

interface PriorityBadgeProps {
  priority: 'high' | 'medium' | 'low'
  onClick?: () => void
}

export function PriorityBadge({ priority, onClick }: PriorityBadgeProps) {
  const c = PRIORITY_COLORS[priority]
  const inner = (
    <span style={{
      display: 'inline-flex', alignItems: 'center',
      fontSize: fontSize.sm, fontWeight: fontWeight.semibold,
      padding: '3px 10px', borderRadius: radius.sm,
      background: c.fill, color: c.text,
    }}>
      {c.label}
    </span>
  )
  if (!onClick) return inner
  return (
    <button
      onClick={onClick}
      style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', display: 'inline-flex' }}
    >
      {inner}
    </button>
  )
}
