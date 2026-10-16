// Test helpers for the two color modes: resolve a web `color` token (a CSS
// variable) to its literal value in each mode, and measure WCAG contrast.
import { color as lightColor } from '../../../shared/tokens'
import { darkColor, cssVarName, type ColorToken } from '../styles/colorModes'

export type Mode = 'light' | 'dark'

export const PALETTES: Record<Mode, Record<ColorToken, string>> = { light: lightColor, dark: darkColor }

const TOKEN_BY_VAR = new Map(
  (Object.keys(lightColor) as ColorToken[]).map((k) => [`var(${cssVarName(k)})`, k]),
)

/** `var(--fv-text-primary)` → `textPrimary`; throws on anything that isn't a color token. */
export function tokenOf(cssValue: string): ColorToken {
  const token = TOKEN_BY_VAR.get(cssValue.trim())
  if (!token) throw new Error(`not a color token variable: ${JSON.stringify(cssValue)}`)
  return token
}

/** The literal hex a web color value resolves to in `mode`. */
export function resolveColor(cssValue: string, mode: Mode): string {
  return PALETTES[mode][tokenOf(cssValue)]
}

export function relLuminance(hex: string): number {
  let h = hex.replace('#', '')
  if (h.length === 3) h = h.split('').map((c) => c + c).join('')
  const [r, g, b] = [0, 2, 4]
    .map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

export function contrast(fg: string, bg: string): number {
  const a = relLuminance(fg)
  const b = relLuminance(bg)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

/**
 * A rendered primary button, checked at the call site: no `opacity` layered over
 * its colors (that drops the label below the bar the colors were chosen for), and
 * its text-on-fill contrast clears `min` in both color modes. `min` is 4.5 for an
 * enabled button and 3 for a disabled one (WCAG exempts disabled controls).
 */
export function buttonTextContrast(btn: HTMLElement, mode: Mode): number {
  return contrast(resolveColor(btn.style.color, mode), resolveColor(btn.style.background, mode))
}
