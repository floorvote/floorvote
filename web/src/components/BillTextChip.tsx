import { safeDate } from '../lib/dates'
import { normalizeVersionNote } from '../lib/billText'
import { color, fontSize, fontWeight, radius } from '../styles/tokens'

type Props = {
  /** Another bill's number, for a version of a companion's text shown beside this bill's (#571). */
  billNumber?: string
  type: string | null | undefined
  date: string | null | undefined
  selected?: boolean
  onClick?: () => void
  title?: string
}

export function BillTextChip({ billNumber, type, date, selected = false, onClick, title }: Props) {
  const label = normalizeVersionNote(type)
  const safe = safeDate(date)
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      style={{
        fontSize: fontSize.sm,
        padding: '3px 10px',
        borderRadius: radius.xl,
        border: '1px solid',
        cursor: onClick ? 'pointer' : 'default',
        background: selected ? color.linkBlue : color.white,
        color: selected ? color.textOnFill : color.textSlate,
        borderColor: selected ? color.linkBlue : color.borderStrong,
        fontFamily: 'inherit',
      }}
    >
      {billNumber && <span style={{ fontWeight: fontWeight.semibold, marginRight: 4 }}>{billNumber}</span>}
      {label}{safe && <span style={{ opacity: 0.7, marginLeft: 4 }}>{safe}</span>}
    </button>
  )
}
