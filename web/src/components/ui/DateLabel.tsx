import { color, fontSize, fontWeight } from '../../styles/tokens'

/**
 * A consistently-styled day label: small uppercase caption, muted gray, amber when
 * it's today. Shared by the day dividers and the upcoming-hearings widget so dates
 * read the same everywhere.
 */
export function DateLabel({ label, isToday = false }: { label: string; isToday?: boolean }) {
  return (
    <span style={{
      fontSize: fontSize.xs,
      fontWeight: fontWeight.semibold,
      textTransform: 'uppercase',
      color: isToday ? color.accentAmber : color.textMuted,
      whiteSpace: 'nowrap',
    }}>{label}</span>
  )
}
