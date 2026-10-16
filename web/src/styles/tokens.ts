// Radii, font sizes, weights, shadows, and fonts are the shared literals.
// Colors are CSS variables, so the app follows the color mode (./colorModes.ts):
// `color.textPrimary` is `var(--fv-text-primary)`. The literal palette, for code
// that needs real values (email templates, contrast checks), is shared/tokens.ts.
import { color as lightColor } from '../../../shared/tokens'
import { cssVarName, type ColorToken } from './colorModes'

export { radius, fontSize, fontWeight, shadow, BRAND_FONT, BODY_FONT } from '../../../shared/tokens'

export const color = Object.fromEntries(
  Object.keys(lightColor).map((k) => [k, `var(${cssVarName(k)})`]),
) as { readonly [K in ColorToken]: string }
