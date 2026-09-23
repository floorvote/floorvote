import { color, radius, fontSize } from '../styles/tokens'

/**
 * Trigger-button style for a full-width, form-field-styled Picker (as opposed
 * to the compact chip triggers used by ScopeSelect/CustomFieldsSection).
 * Matches the look of a plain text <input> in an admin form so a Picker can
 * drop into a label+field row without changing the surrounding layout.
 */
export function pickerFieldTriggerStyle(): React.CSSProperties {
  return {
    width: '100%',
    fontSize: fontSize.sm,
    padding: '8px 10px',
    border: `1px solid ${color.borderDefault}`,
    borderRadius: radius.md,
    boxSizing: 'border-box',
    fontFamily: 'inherit',
    background: color.white,
    color: color.textSlate,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    cursor: 'pointer',
    textAlign: 'left',
  }
}

export function PickerFieldCaret({ open }: { open: boolean }) {
  return (
    <svg width="10" height="6" viewBox="0 0 10 6" fill="none" style={{ flexShrink: 0 }}>
      <path
        d={open ? 'M1 5l4-4 4 4' : 'M1 1l4 4 4-4'}
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
