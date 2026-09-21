import { color, radius, fontSize, fontWeight } from '../styles/tokens'

export interface MemberNameCellProps {
  name: string
  email: string
  subtitle?: string | null
  isSelf?: boolean
}

// The shared name-cell body for both member surfaces: the admin Members table
// and the sidebar members popup. Order is always name → subtitle → email.
//
// The email is a blue-link on both surfaces. The admin table used to render it
// as muted gray with four inline handlers toggling text-decoration; that was
// the only thing keeping the two cells from being identical, and .blue-link
// already does colour + hover underline in CSS.
//
// break-all lives on the email alone, never on the cell: an address has no
// break opportunities and must wrap inside a fixed-width column, but the same
// rule on the cell would also split the member's name mid-word.
export function MemberNameCell({ name, email, subtitle, isSelf = false }: MemberNameCellProps) {
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ fontWeight: isSelf ? fontWeight.bold : fontWeight.medium, color: color.textPrimary }}>{name}</span>
        {isSelf && (
          <span style={{
            fontSize: fontSize.xs, fontWeight: fontWeight.bold, color: color.countChipText,
            background: color.countChipBg, borderRadius: radius.sm, padding: '1px 5px',
            letterSpacing: '0.05em', flexShrink: 0,
          }}>ME</span>
        )}
      </div>
      {subtitle && (
        <div style={{ fontSize: fontSize.sm, color: color.textSlate500, marginTop: 1 }}>{subtitle}</div>
      )}
      <a
        href={`mailto:${email}`}
        className="blue-link"
        style={{ fontSize: fontSize.sm, display: 'block', wordBreak: 'break-all' }}
      >
        {email}
      </a>
    </>
  )
}
