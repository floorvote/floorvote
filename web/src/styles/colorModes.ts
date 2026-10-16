/**
 * The app's two color modes. Light is the literal palette in shared/tokens.ts
 * (which the API's emails also use); dark is below. Both become CSS custom
 * properties (`--fv-text-primary`, ...) in a <style> that vite.config.ts writes
 * into index.html, so the colors are in place before the first paint. The web
 * `color` tokens in ./tokens.ts are `var(--fv-...)` references to them.
 *
 * Dark mode is the `dark` class on <html>, set by public/color-mode.js before
 * paint and by lib/colorMode.ts after that. Tiptap's editor styles key on the
 * same class.
 *
 * Each dark value keeps its token's meaning: tinted fills go dark, text and the
 * colors drawn on them go light, so a token used as text and as a fill (link
 * blue, priority reds, badge navy) works both ways with textOnFill on top.
 * contrast.test.ts checks the main text pairs in both modes.
 */
import { color as lightColor } from '../../../shared/tokens'

export type ColorToken = keyof typeof lightColor

export const darkColor: Record<ColorToken, string> = {
  // --- Text ---
  textPrimary:       '#e8edf4',
  textSecondary:     '#a7b2c2',
  textMuted:         '#94a0b2',
  textSlate:         '#ccd5e1',
  textSlate500:      '#b6c0ce',
  countChipText:     '#a3aebf',
  textSuccess:       '#4ade80',
  textSuccessDark:   '#86efac',
  textDanger:        '#fca5a5',
  textErrorRed:      '#f87171',
  priorityHigh:      '#ff5c86',
  priorityMedium:    '#f59aab',
  priorityLow:       '#b98a91',
  textAmberDark:     '#fbbf72',
  textAmberHearing:  '#e8a33d', // Honey; the legacy #f59e0b is retired
  textAmberWarning:  '#fcd34d',
  textVioletChip:    '#c4b5fd',
  textTealSenate:    '#5eead4',
  roleMentionText:   '#a5b4fc',
  textOnFill:        '#0d131c',
  textOnBrand:       '#fff',
  textOnBrandMuted:  '#93c5fd',

  // --- Brand, link & accent ---
  linkBlue:          '#7fb0ff',
  accentBlue:        '#60a5fa',
  accentBlueMuted:   '#35537d',
  brandViolet:       '#a78bfa',
  accentAmber:       '#e8a33d', // Honey, unchanged: it fills the logo mark, which is never recolored
  voteSupport:       '#3fcf73',
  billBadgeNavy:     '#9dbbe6',
  wordmarkFloor:     '#fff',   // the brand's on-dark lockup: white "Floor"
  brandNavy:         '#1a2d47',
  focusRing:         '#9dbbe6',
  tagTextBlue:       '#93c5fd',
  tooltipBg:         '#dfe5ee',

  // --- Claim links ---
  claimUnderline:    '#e8a33d', // Honey, unchanged: it reads on the dark card as on the light one
  claimHoverBg:      '#3a3020', // a dark Honey wash; text on it keeps its color (textPrimary 11:1)
  passageMarkBg:     '#5c4512',
  passageMarkText:   '#e8edf4', // 7.7:1 on the fill. The bill's frame shows a light page in both modes, so the frame itself uses the light pair

  // --- Surface & background ---
  white:             '#182231',
  surfaceSubtle:     '#141d2a',
  surfaceMuted:      '#121a26',
  countChipBg:       '#243146',
  bgLoginPage:       '#0d131c',
  bgInfo:            '#16263f',
  bgBlueChip:        '#1c3254',
  roleMentionBg:     '#262f5c',
  bgSuccess:         '#10251a',
  bgSuccessChip:     '#14381f',
  bgSuccessFaint:    '#122019',
  bgTeal:            '#0f2826',
  bgTealChip:        '#14443f',
  bgVioletSoft:      '#1f1a35',
  bgVioletChip:      '#2c2350',
  bgDangerSoft:      '#2a1619',
  bgDangerFaint:     '#1d1619',
  bgRedPriority:     '#3d1a20',
  bgRedDisabled:     '#7a4a4e',
  bgAmberPriority:   '#352a11',
  bgWarnSoft:        '#2a2210',

  // --- Border ---
  borderDefault:     '#263244',
  borderStrong:      '#3a4a63',
  borderGreenChip:   '#1f5a36',
  borderGreenStrong: '#2f7a4a',
  borderGreenFaint:  '#1d3a29',
  borderNeutralFaint:'#1f2a39',
  borderRedChip:     '#5c2a31',
  borderRedFaint:    '#3b2227',
  borderVioletSoft:  '#5b4a99',
  borderPurpleChip:  '#3f3068',
  borderAmber:       '#8a6a1f',
  borderTealChip:    '#1f6b62',
  borderYellow:      '#8a7a1a',
  borderBlueDash:    '#35598c',
  tagBorderBlue:     '#2b4b7a',
}

/** `textPrimary` → `--fv-text-primary`. */
export function cssVarName(token: string): string {
  return '--fv-' + token.replace(/[A-Z0-9]+/g, (m) => '-' + m.toLowerCase())
}

function declarations(palette: Record<string, string>): string {
  return Object.entries(palette).map(([k, v]) => `${cssVarName(k)}:${v};`).join('')
}

/** The stylesheet vite.config.ts writes into index.html. */
export function colorVariablesCss(): string {
  return `:root{color-scheme:light;${declarations(lightColor)}}` +
    `:root.dark{color-scheme:dark;${declarations(darkColor)}}`
}
