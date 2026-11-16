import { color, radius } from '../../styles/tokens'

const TRACK_BOX: React.CSSProperties = { position: 'relative', display: 'inline-block', width: 38, height: 24, flexShrink: 0 }

interface SwitchControlProps {
  /** The input's id, for a label that names it with `htmlFor`. */
  id?: string
  checked: boolean
  /** Not available: the demo is locked, or email to members is turned off. Shows the not-allowed cursor. */
  disabled: boolean
  /** A save is in flight. Changes are ignored while it is, and keyboard focus stays on the switch. */
  busy?: boolean
  /** Where the switch sits isn't known yet. Nothing is drawn in its place, at its size, until it is. */
  pending?: boolean
  onChange: (next: boolean) => void
  /** Name the switch with exactly one of these. */
  ariaLabel?: string
  ariaLabelledBy?: string
  ariaDescribedBy?: string
}

/**
 * The switch every Notifications setting uses. It goes inside the <label> that
 * holds the setting's sentence, so a click on the sentence toggles it. The
 * input is visually hidden (0x0), so the focus ring is drawn on the track
 * that follows it (`.fv-switch-input:focus-visible + span` in mobile.css).
 */
export function SwitchControl({ checked, disabled, busy = false, pending = false, onChange, ariaLabel, ariaLabelledBy, ariaDescribedBy, id }: SwitchControlProps) {
  if (pending) return <span aria-hidden="true" style={TRACK_BOX} />
  return (
    <span style={{ ...TRACK_BOX, cursor: disabled ? 'not-allowed' : 'pointer' }}>
      <input
        id={id}
        type="checkbox"
        role="switch"
        className="fv-switch-input"
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        aria-describedby={ariaDescribedBy}
        aria-disabled={busy || undefined}
        checked={checked}
        disabled={disabled}
        onChange={(e) => { if (!busy) onChange(e.target.checked) }}
        style={{ opacity: 0, width: 0, height: 0, position: 'absolute' }}
      />
      <span
        style={{
          position: 'absolute',
          inset: 0,
          background: checked ? color.accentBlue : color.borderStrong,
          borderRadius: radius.pill,
          transition: 'background 0.18s ease',
        }}
      />
      <span
        style={{
          position: 'absolute',
          top: 2,
          left: checked ? 16 : 2,
          width: 20,
          height: 20,
          background: color.white,
          borderRadius: '50%',
          transition: 'left 0.18s ease',
          boxShadow: '0 1px 3px rgba(0,0,0,0.25)',
        }}
      />
    </span>
  )
}
