import { POSITION_COLORS, POSITION_FALLBACK } from '../lib/chipStyles'
import { fontSize, fontWeight, radius } from '../styles/tokens'

interface PositionBadgeProps {
  position: string
}

export function PositionBadge({ position }: PositionBadgeProps) {
  const c = POSITION_COLORS[position] ?? POSITION_FALLBACK

  return (
    <span style={{ position: 'relative', display: 'inline-flex' }}>
      <span style={{
        display: 'inline-flex', alignItems: 'center',
        background: c.bg, color: c.color, border: '1px solid transparent',
        fontWeight: fontWeight.semibold, fontSize: fontSize.sm, padding: '3px 10px', borderRadius: radius.sm,
      }}>
        {position}
      </span>
    </span>
  )
}
