import type { CSSProperties, ReactNode } from 'react'
import { color, radius, fontSize } from '../../styles/tokens'

export const SELECT: CSSProperties = {
  fontSize: fontSize.sm,
  padding: '3px 6px',
  borderRadius: radius.sm,
  border: `1px solid ${color.borderDefault}`,
  fontFamily: 'inherit',
}

/** A menu on the Notifications page with its label in front, such as "How often" or a day of the week. */
export function SelectField({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <label htmlFor={id} style={{ fontSize: fontSize.sm, color: color.textSlate500, minWidth: 120 }}>{label}</label>
      {children}
    </div>
  )
}
