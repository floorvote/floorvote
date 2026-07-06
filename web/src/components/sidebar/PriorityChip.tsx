import { PRIORITY_COLORS, CHIP_MINI } from '../../lib/chipStyles'
import { color, radius, fontSize, fontWeight } from '../../styles/tokens'

export function PriorityChip({ priority, mini }: { priority: string; mini?: boolean }) {
  const c = PRIORITY_COLORS[priority] ?? { text: color.textSecondary, fill: color.surfaceMuted, dot: color.surfaceMuted, label: '' }
  // Shared label on both variants (mini only differs in font/padding) — keeps
  // the "… priority" wording in one place so the chip never drifts.
  const label = c.label || priority
  const base = mini ? CHIP_MINI : { display: 'inline-flex' as const, alignItems: 'center' as const, fontSize: fontSize.sm, fontWeight: fontWeight.semibold, padding: '3px 10px', borderRadius: radius.sm }
  return (
    <span style={{ ...base, background: c.fill, color: c.text, flexShrink: 0 }}>
      {label}
    </span>
  )
}
