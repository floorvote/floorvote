import { color, fontSize, fontWeight, radius } from '../styles/tokens'

/**
 * The date of a bill's last action, as the Bills page's "Last action" column
 * and the split pane both draw it (a dash when the bill has none). Not
 * clickable: it says when, and filters nothing. `className` lets the Bills
 * page hide it at narrow widths.
 */
export function LastActionChip({ date, className }: { date: string | null; className?: string }) {
  return (
    <span className={className} style={{
      display: 'inline-flex', alignItems: 'center',
      fontSize: fontSize.sm, fontWeight: fontWeight.semibold, padding: '3px 10px', borderRadius: radius.sm,
      border: '1px solid transparent', background: color.countChipBg, color: color.textSecondary,
    }}>
      {date ?? '—'}
    </span>
  )
}
