import { color, radius } from '../../styles/tokens'

interface IosToggleProps {
  checked: boolean
  /** Permanently disabled (demo lock, etc.). Shows not-allowed cursor. */
  disabled: boolean
  /** Transient saving state. Blocks interaction without changing cursor. */
  busy: boolean
  onChange: (next: boolean) => void
  ariaLabel: string
}

export function IosToggle({ checked, disabled, busy, onChange, ariaLabel }: IosToggleProps) {
  const onColor = color.accentBlue
  const offColor = color.borderStrong
  const interactionBlocked = disabled || busy
  return (
    <label
      style={{
        position: 'relative',
        display: 'inline-block',
        width: 38,
        height: 22,
        flexShrink: 0,
        cursor: disabled ? 'not-allowed' : 'pointer',
      }}
    >
      <input
        type="checkbox"
        role="switch"
        aria-label={ariaLabel}
        checked={checked}
        disabled={interactionBlocked}
        onChange={(e) => { if (!interactionBlocked) onChange(e.target.checked) }}
        style={{ opacity: 0, width: 0, height: 0, position: 'absolute' }}
      />
      <span
        style={{
          position: 'absolute',
          inset: 0,
          background: checked ? onColor : offColor,
          borderRadius: radius.pill,
          transition: 'background 0.18s ease',
        }}
      />
      <span
        style={{
          position: 'absolute',
          top: 2,
          left: checked ? 18 : 2,
          width: 18,
          height: 18,
          background: color.white,
          borderRadius: '50%',
          transition: 'left 0.18s ease',
          boxShadow: '0 1px 3px rgba(0,0,0,0.25)',
        }}
      />
    </label>
  )
}
