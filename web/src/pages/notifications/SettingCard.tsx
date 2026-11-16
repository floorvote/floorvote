import { useId } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { SwitchControl } from './SwitchControl'
import { CARD } from '../../lib/cardStyle'
import { CARD_TITLE } from '../../lib/textStyles'
import { color, fontSize, fontWeight } from '../../styles/tokens'

interface SettingCardProps {
  /** The anchor an email links to (`#setting-…`). */
  id?: string
  /** Amber ring for about a second after a deep link lands on the card. */
  flashed?: boolean
  /** Dims the whole card: a locked demo, or email to members turned off. */
  dimmed?: boolean
  children: ReactNode
}

/** One boxed email on the Notifications page: its title and switch, then whatever sits under it. */
export function SettingCard({ id, flashed = false, dimmed = false, children }: SettingCardProps) {
  return (
    <section
      id={id}
      style={{
        ...CARD,
        padding: 24,
        marginBottom: 20,
        opacity: dimmed ? 0.55 : 1,
        boxShadow: flashed ? `0 0 0 3px ${color.borderAmber}` : undefined,
        transition: 'box-shadow 0.6s ease',
      }}
    >
      {children}
    </section>
  )
}

/** A part inside a card: plain bold text, not a heading. */
export const PART_TITLE: CSSProperties = { fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: color.textPrimary }

interface SwitchRowProps {
  title: string
  /** `card` for a card's own title (an h2, so the page outline lists the emails). `part` for a part inside a card, which is plain text. */
  titleVariant?: 'card' | 'part'
  titleId?: string
  description?: ReactNode
  descriptionId?: string
  /** The switch's accessible name. Omit it to name the switch by `titleId`. */
  ariaLabel?: string
  checked: boolean
  disabled: boolean
  busy?: boolean
  onChange: (next: boolean) => void
}

/** A title and description on the left, a switch on the right, all one <label> so the sentence toggles the switch. */
export function SwitchRow({ title, titleVariant = 'part', titleId, description, descriptionId, ariaLabel, checked, disabled, busy, onChange }: SwitchRowProps) {
  const ownDescriptionId = useId()
  const describedBy = descriptionId ?? ownDescriptionId
  const switchId = useId()
  return (
    <label htmlFor={switchId} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, cursor: disabled ? 'not-allowed' : 'pointer' }}>
      <div style={{ fontSize: fontSize.sm, color: color.textSlate, lineHeight: 1.5 }}>
        {titleVariant === 'card'
          ? <h2 id={titleId} style={CARD_TITLE}>{title}</h2>
          : <div id={titleId} style={PART_TITLE}>{title}</div>}
        <div id={describedBy}>{description}</div>
      </div>
      <SwitchControl
        checked={checked}
        disabled={disabled}
        busy={busy}
        onChange={onChange}
        id={switchId}
        ariaLabel={ariaLabel}
        ariaLabelledBy={ariaLabel ? undefined : titleId}
        ariaDescribedBy={describedBy}
      />
    </label>
  )
}
