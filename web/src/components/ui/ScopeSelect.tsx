import { Picker } from '../Picker'
import { color, radius, fontSize, fontWeight } from '../../styles/tokens'

export interface ScopeSelectOption<V extends string = string> {
  value: V
  label: string
  /** Optional hover hint shown above the option in the dropdown. */
  description?: string
}

/**
 * A compact single-select "scope" dropdown: a button showing the current
 * option's label, opening a radio list (with optional per-option hover hints).
 * Built on the shared {@link Picker} so the popover, outside-click, and radio
 * behaviour match every other dropdown in the app.
 *
 * The trigger is highlighted (blue) whenever `value` differs from
 * `defaultValue`, matching the "filter is non-default" affordance used on Feed.
 * Omit `defaultValue` to keep the trigger neutral regardless of selection.
 */
export function ScopeSelect<V extends string = string>({
  options,
  value,
  onChange,
  defaultValue,
  disabled = false,
  align = 'right',
  panelMinWidth = 220,
}: {
  options: ScopeSelectOption<V>[]
  value: V
  onChange: (v: V) => void
  defaultValue?: V
  disabled?: boolean
  align?: 'left' | 'right'
  panelMinWidth?: number
}) {
  const current = options.find(o => o.value === value) ?? options[0]
  const highlighted = defaultValue !== undefined && value !== defaultValue

  return (
    <Picker
      mode="single"
      value={value}
      options={options}
      onChange={(v) => { if (v !== null) onChange(v as V) }}
      align={align}
      panelMinWidth={panelMinWidth}
      trigger={({ open, toggle }) => (
        <button
          type="button"
          disabled={disabled}
          onClick={toggle}
          style={{
            fontSize: fontSize.sm,
            padding: '6px 10px',
            borderRadius: radius.md,
            cursor: disabled ? 'default' : 'pointer',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
            whiteSpace: 'nowrap',
            maxWidth: '100%',
            background: highlighted ? color.bgInfo : color.white,
            color: highlighted ? color.linkBlue : color.textSlate,
            border: `1px solid ${highlighted ? color.tagBorderBlue : color.borderDefault}`,
            fontWeight: highlighted ? fontWeight.medium : fontWeight.normal,
            fontFamily: 'inherit',
          }}
        >
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{current.label}</span>
          <svg width="10" height="6" viewBox="0 0 10 6" fill="none" style={{ flexShrink: 0 }}>
            <path
              d={open ? 'M1 5l4-4 4 4' : 'M1 1l4 4 4-4'}
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      )}
    />
  )
}
