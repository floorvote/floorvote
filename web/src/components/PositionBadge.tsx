import { useState, useRef } from 'react'
import { POSITION_COLORS, POSITION_FALLBACK, TOOLTIP_STYLE, tooltipPosition } from '../lib/chipStyles'
import { fontSize, fontWeight, radius } from '../styles/tokens'

interface PositionBadgeProps {
  position: string
  tooltip?: string
}

export function PositionBadge({ position, tooltip }: PositionBadgeProps) {
  const c = POSITION_COLORS[position] ?? POSITION_FALLBACK
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const ref = useRef<HTMLSpanElement>(null)

  return (
    <span
      ref={ref}
      style={{ position: 'relative', display: 'inline-flex' }}
      onMouseEnter={tooltip ? () => {
        if (ref.current) {
          const r = ref.current.getBoundingClientRect()
          setPos({ x: r.left + r.width / 2, y: r.top })
        }
      } : undefined}
      onMouseLeave={tooltip ? () => setPos(null) : undefined}
    >
      <span style={{
        display: 'inline-flex', alignItems: 'center',
        background: c.bg, color: c.color, border: `1px solid ${c.border}`,
        fontWeight: fontWeight.semibold, fontSize: fontSize.sm, padding: '3px 10px', borderRadius: radius.sm,
      }}>
        {position}
      </span>
      {pos && tooltip && (
        <span style={{ ...tooltipPosition(pos), ...TOOLTIP_STYLE }}>{tooltip}</span>
      )}
    </span>
  )
}
