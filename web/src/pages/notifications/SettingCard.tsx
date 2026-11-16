import { useId } from 'react'
import type { ReactNode } from 'react'
import { SwitchControl } from './SwitchControl'
import { settingBox } from '../../lib/settingBoxStyle'
import { color, fontSize, fontWeight } from '../../styles/tokens'

interface SettingCardProps {
  /** The anchor an email links to (`#setting-…`). Cards on the team side carry none, so each anchor stays unique. */
  id?: string
  /** Amber ring for about a second after a deep link lands on the card. */
  flashed?: boolean
  /** Dims the whole card: a locked demo, or an email the team turned off. */
  dimmed?: boolean
  children: ReactNode
}

/** One boxed email on the Notifications page: its heading and switch, then whatever sits under it. */
export function SettingCard({ id, flashed = false, dimmed = false, children }: SettingCardProps) {
  return (
    <section
      id={id}
      style={{
        ...settingBox(dimmed),
        boxShadow: flashed ? `0 0 0 3px ${color.borderAmber}` : undefined,
        transition: 'box-shadow 0.6s ease',
      }}
    >
      {children}
    </section>
  )
}

interface SwitchRowProps {
  title: string
  /** True for a card's own title, so the page outline lists the emails. A part inside a card is plain text. */
  heading?: boolean
  titleId?: string
  /** Beside the title, such as an info icon. It sits inside the label, so it stays outside the element `titleId` names the switch by. */
  titleExtra?: ReactNode
  description?: ReactNode
  descriptionId?: string
  /** The switch's accessible name. Omit it to name the switch by `titleId`. */
  ariaLabel?: string
  checked: boolean
  disabled: boolean
  busy?: boolean
  /** Where the switch sits isn't known yet, so it is left out until it is (SwitchControl's `pending`). */
  pending?: boolean
  /**
   * The org noun, when the team turned this email or part off. The switch then shows off and can't be changed, with
   * "Turned off by your {org noun}." under the description. The person's own choice stays saved, and the switch shows
   * it again once the team turns the email or part back on.
   */
  turnedOffBy?: string
  onChange: (next: boolean) => void
}

/** A title and description on the left, a switch on the right, all one <label> so the sentence toggles the switch. */
export function SwitchRow({ title, heading = false, titleId, titleExtra, description, descriptionId, ariaLabel, checked, disabled, busy, pending, turnedOffBy, onChange }: SwitchRowProps) {
  const teamOff = turnedOffBy !== undefined
  // Every switch is described by its description and any turned-off note, named by `ariaLabel` or not.
  const ownDescriptionId = useId()
  const describedBy = descriptionId ?? ownDescriptionId
  const switchId = useId()
  return (
    <label htmlFor={switchId} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, cursor: disabled || teamOff ? 'not-allowed' : 'pointer' }}>
      <div style={{ fontSize: fontSize.sm, color: color.textSlate, lineHeight: 1.5 }}>
        <div style={titleExtra ? { display: 'flex', alignItems: 'center', gap: 4 } : undefined}>
          <div
            id={titleId}
            {...(heading ? { role: 'heading', 'aria-level': 3 } : {})}
            style={{ color: color.textPrimary, ...(heading ? { fontWeight: fontWeight.bold } : {}) }}
          >
            {title}
          </div>
          {titleExtra}
        </div>
        <div id={describedBy}>{description}{teamOff && <TurnedOffNote orgNoun={turnedOffBy} />}</div>
      </div>
      <SwitchControl
        checked={checked && !teamOff}
        disabled={disabled || teamOff}
        busy={busy}
        pending={pending}
        onChange={onChange}
        id={switchId}
        ariaLabel={ariaLabel}
        ariaLabelledBy={ariaLabel ? undefined : titleId}
        ariaDescribedBy={describedBy}
      />
    </label>
  )
}

/** A short note under a setting's description, such as who set it. */
export function NoteLine({ children }: { children: ReactNode }) {
  return (
    <div style={{ marginTop: 2, fontSize: fontSize.sm, color: color.textMuted, fontWeight: fontWeight.medium }}>
      {children}
    </div>
  )
}

/** "Turned off by your {org noun}." under a card's description. */
export function TurnedOffNote({ orgNoun }: { orgNoun: string }) {
  return <NoteLine>Turned off by your {orgNoun}.</NoteLine>
}
