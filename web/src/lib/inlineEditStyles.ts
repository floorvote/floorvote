import type React from 'react'
import { color, radius, fontSize } from '../styles/tokens'

// Save/Cancel for an inline rename form. Shared so the saved-views switcher
// and the custom-fields editor cannot drift apart again — they had diverged on
// colour (navy vs accentBlue), size (xs vs sm), padding, and whether a Cancel
// button existed at all.
//
// Both forms lay these out ON the input's line. Custom fields keeps its extra
// dropdown controls (options, "allow multiple") stacked beneath, because those
// are separate fields rather than actions — only the buttons come up onto the
// first line.
const base: React.CSSProperties = {
  fontFamily: 'inherit', fontSize: fontSize.sm, padding: '3px 10px',
  borderRadius: radius.sm, cursor: 'pointer', whiteSpace: 'nowrap',
}

export function inlineEditSaveStyle(disabled = false): React.CSSProperties {
  return {
    ...base,
    border: 'none',
    background: disabled ? color.borderDefault : color.accentBlue,
    color: disabled ? color.textMuted : color.white,
    cursor: disabled ? 'not-allowed' : 'pointer',
  }
}

export function inlineEditCancelStyle(): React.CSSProperties {
  return {
    ...base,
    border: `1px solid ${color.borderDefault}`,
    background: color.white,
    color: color.textSlate,
  }
}
