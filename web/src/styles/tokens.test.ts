import { describe, it, expect } from 'vitest'
import { color as lightColor, radius, fontSize, fontWeight } from '../../../shared/tokens'
import { color } from './tokens'
import { darkColor, colorVariablesCss } from './colorModes'
import { contrast, relLuminance } from '../test/colorTokens'

describe('tokens', () => {
  it('exposes expected primitive values', () => {
    expect(lightColor.textMuted).toBe('#667386')
    expect(lightColor.borderDefault).toBe('#e2e8f0')
    expect(lightColor.white).toBe('#fff')
    expect(radius.md).toBe(6)
    expect(radius.pill).toBe(999)
    expect(fontSize.sm).toBe(12)   // 11/12/13 collapsed here
    expect(fontSize.base).toBe(14)
    expect(fontSize.xxxl).toBe(22)
    expect(fontWeight.semibold).toBe(600)
    expect(fontWeight.heavy).toBe(600)
  })

  it('all token values are serializable primitives (string|number)', () => {
    for (const group of [lightColor, radius, fontSize, fontWeight]) {
      for (const v of Object.values(group)) {
        expect(['string', 'number']).toContain(typeof v)
      }
    }
  })

  it('exposes a focusRing color token (navy, for the focus-visible ring)', () => {
    expect(lightColor.focusRing).toBe('#1e3a5f')
  })

  it('gives the web every color as a CSS variable defined in both modes', () => {
    expect(color.textPrimary).toBe('var(--fv-text-primary)')
    expect(color.textSlate500).toBe('var(--fv-text-slate-500)')
    expect(color.focusRing).toBe('var(--fv-focus-ring)') // mobile.css overrides this one by name
    const css = colorVariablesCss()
    for (const v of Object.values(color)) {
      const name = v.slice(4, -1)
      expect(css.split(`${name}:`).length - 1, name).toBe(2)
    }
  })
})

// --- Brand colors in dark mode ----------------------------------------------
// Honey is the brand accent and the logo mark's fill, so it never changes with
// the mode (the mark is never recolored). It already reads on the dark surfaces.
// The legacy amber #f59e0b is being retired toward Honey and may not come back
// in either palette.
describe('brand colors in both modes', () => {
  it('keeps Honey (accentAmber) at #e8a33d in dark mode, as in light', () => {
    expect(lightColor.accentAmber).toBe('#e8a33d')
    expect(darkColor.accentAmber).toBe('#e8a33d')
  })

  it('uses the legacy amber #f59e0b nowhere, in either palette', () => {
    for (const [mode, palette] of [['light', lightColor], ['dark', darkColor]] as const) {
      for (const [token, value] of Object.entries(palette)) {
        expect(value.toLowerCase(), `${mode} ${token}`).not.toBe('#f59e0b')
      }
    }
  })
})

// --- WCAG AA contrast guard -------------------------------------------------
// Regression guard from the 2026-06-24 contrast audit, run against both color
// modes. Every gray text tier must clear WCAG 2.2 AA (4.5:1 for normal text) on
// every neutral surface it renders on, and each colored chip's text must clear
// AA on its own fill. textMuted/textSecondary were darkened and surfaceMuted
// lightened to satisfy this; if a gray or surface is later changed below the
// line, this fails in CI before it can ship. (textMuted on bgLoginPage/bgInfo is
// intentionally not asserted — muted text there sits on a white card, not the
// tinted page fill.)

const AA_NORMAL = 4.5
const AA_GRAPHICS = 3

const MODES: [string, Record<keyof typeof lightColor, string>][] = [
  ['light', lightColor],
  ['dark', darkColor],
]

for (const [mode, c] of MODES) {
  describe(`WCAG AA contrast (${mode})`, () => {
    const SURFACES = ['white', 'surfaceSubtle', 'surfaceMuted'] as const
    // Gray text tiers and links on every neutral surface. The priority colors
    // are markers (squares and dots), so they need WCAG's 3:1 for graphics.
    const TEXT = ['textPrimary', 'textSlate', 'textSlate500', 'textSecondary', 'textMuted', 'linkBlue'] as const
    const MARKERS = ['priorityHigh', 'priorityMedium', 'priorityLow'] as const
    const PAIRS: [string, string, string, number?][] = []
    for (const s of SURFACES) {
      for (const t of TEXT) PAIRS.push([`${t} on ${s}`, c[t], c[s]])
      for (const m of MARKERS) PAIRS.push([`${m} on ${s}`, c[m], c[s], AA_GRAPHICS])
    }

    // Colored chip text on its own fill, active nav, and text on colored fills.
    PAIRS.push(
      ['success chip', c.textSuccessDark, c.bgSuccessChip],
      ['danger chip', c.textDanger, c.bgRedPriority],
      ['amber chip', c.textAmberDark, c.bgAmberPriority],
      ['violet chip', c.textVioletChip, c.bgVioletChip],
      ['teal chip', c.textTealSenate, c.bgTeal],
      ['tag chip', c.tagTextBlue, c.bgBlueChip],
      ['role mention', c.roleMentionText, c.roleMentionBg],
      ['user mention', c.textSlate500, c.borderDefault],
      ['hearing chip', c.billBadgeNavy, c.bgInfo],
      ['neutral fallback chip', c.textSlate500, c.surfaceMuted],
      ['count chip', c.countChipText, c.countChipBg],
      ['active nav', c.billBadgeNavy, c.bgAmberPriority],
      ['warning banner', c.textAmberWarning, c.bgWarnSoft],
      ['bill badge', c.textOnFill, c.billBadgeNavy],
      ['brand strip', c.textOnBrand, c.brandNavy],
      ['blue button', c.textOnFill, c.linkBlue],
      ['high priority chip', c.textOnFill, c.priorityHigh],
      ['amend icon on the card', c.textAmberHearing, c.white],
      ['wordmark Floor on the card', c.wordmarkFloor, c.white],
      ['wordmark Floor on the login page', c.wordmarkFloor, c.bgLoginPage],
    )

    for (const [label, fg, bg, min = AA_NORMAL] of PAIRS) {
      it(`${label} clears AA`, () => {
        const ratio = contrast(fg, bg)
        expect(ratio, `${label}: ${fg} on ${bg} = ${ratio.toFixed(2)}:1 (need ${min})`).toBeGreaterThanOrEqual(min)
      })
    }

    it('keeps the gray tiers in order: muted fainter than secondary, fainter than slate500', () => {
      const sign = mode === 'light' ? 1 : -1
      expect(sign * (relLuminance(c.textMuted) - relLuminance(c.textSecondary))).toBeGreaterThan(0)
      expect(sign * (relLuminance(c.textSecondary) - relLuminance(c.textSlate500))).toBeGreaterThan(0)
    })
  })
}
