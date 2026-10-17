import type React from 'react'
import { color } from './tokens'

/**
 * Fill, text, and outline for a primary (solid blue) button, in both color modes.
 *
 * Enabled is textOnFill on linkBlue, which clears AA (4.5:1) in light and dark
 * mode; accentBlue is only 3.68:1 with white in light mode. Disabled is muted
 * text on the muted surface with a hairline outline (the pattern #484 gave the
 * Group bills dialog), so it reads as inactive without dimming the label below
 * legibility. Don't pair it with `opacity`. The outline is an inset shadow, so
 * toggling it doesn't shift the button's layout.
 */
export function primaryButtonColors(disabled: boolean): React.CSSProperties {
  return disabled
    ? { background: color.surfaceMuted, color: color.textMuted, boxShadow: `inset 0 0 0 1px ${color.borderDefault}` }
    : { background: color.linkBlue, color: color.textOnFill }
}
