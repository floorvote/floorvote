import { describe, it, expect } from 'vitest'
import { color, radius, fontSize, fontWeight } from './tokens'

describe('tokens', () => {
  it('exposes expected primitive values', () => {
    expect(color.textMuted).toBe('#667386')
    expect(color.borderDefault).toBe('#e2e8f0')
    expect(color.white).toBe('#fff')
    expect(radius.md).toBe(6)
    expect(radius.pill).toBe(999)
    expect(fontSize.sm).toBe(12)   // 11/12/13 collapsed here
    expect(fontSize.base).toBe(14)
    expect(fontSize.xxxl).toBe(22)
    expect(fontWeight.semibold).toBe(600)
    expect(fontWeight.heavy).toBe(600)
  })

  it('all token values are serializable primitives (string|number)', () => {
    for (const group of [color, radius, fontSize, fontWeight]) {
      for (const v of Object.values(group)) {
        expect(['string', 'number']).toContain(typeof v)
      }
    }
  })

  it('exposes a focusRing color token (navy, for the focus-visible ring)', () => {
    expect(color.focusRing).toBe('#1e3a5f')
  })
})

// --- WCAG AA contrast guard -------------------------------------------------
// Regression guard from the 2026-06-24 contrast audit. Every gray text tier
// must clear WCAG 2.2 AA (4.5:1 for normal text) on every neutral surface it
// renders on, and each colored chip's text must clear AA on its own fill.
// textMuted/textSecondary were darkened and surfaceMuted lightened to satisfy
// this; if a gray or surface is later changed below the line, this fails in CI
// before it can ship. (textMuted on bgLoginPage/bgInfo is intentionally not
// asserted — muted text there sits on a white card, not the tinted page fill.)

function relLuminance(hex: string): number {
  let h = hex.replace('#', '')
  if (h.length === 3)
    h = h
      .split('')
      .map((c) => c + c)
      .join('')
  const [r, g, b] = [0, 2, 4]
    .map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrast(fg: string, bg: string): number {
  const a = relLuminance(fg)
  const b = relLuminance(bg)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

const AA_NORMAL = 4.5

describe('WCAG AA contrast', () => {
  const NEUTRAL_SURFACES: Record<string, string> = {
    white: color.white,
    surfaceSubtle: color.surfaceSubtle,
    surfaceMuted: color.surfaceMuted,
  }
  const GRAY_TEXT: Record<string, string> = {
    textPrimary: color.textPrimary,
    textSlate: color.textSlate,
    textSlate500: color.textSlate500,
    textSecondary: color.textSecondary,
    textMuted: color.textMuted,
  }

  for (const [tName, tHex] of Object.entries(GRAY_TEXT)) {
    for (const [sName, sHex] of Object.entries(NEUTRAL_SURFACES)) {
      it(`${tName} on ${sName} clears AA`, () => {
        const ratio = contrast(tHex, sHex)
        expect(
          ratio,
          `${tName} ${tHex} on ${sName} ${sHex} = ${ratio.toFixed(2)}:1 (need ${AA_NORMAL})`,
        ).toBeGreaterThanOrEqual(AA_NORMAL)
      })
    }
  }

  // Colored chip text must clear AA on its own fill.
  const CHIP_PAIRS: [string, string, string][] = [
    ['success chip', color.textSuccessDark, color.bgSuccessChip],
    ['danger chip', color.textDanger, color.bgRedPriority],
    ['amber chip', color.textAmberDark, color.bgAmberPriority],
    ['purple chip', color.textVioletChip, color.bgVioletChip],
    ['violet chip', color.textVioletChip, color.bgVioletChip],
    ['teal chip', color.textTealSenate, color.bgTeal],
    ['tag chip', color.tagTextBlue, color.bgBlueChip],
    ['role chip', color.white, color.linkBlue],
    ['neutral fallback chip', color.textSlate500, color.surfaceMuted],
    ['count chip', color.countChipText, color.countChipBg],
  ]
  for (const [label, fg, bg] of CHIP_PAIRS) {
    it(`${label} text clears AA`, () => {
      const ratio = contrast(fg, bg)
      expect(
        ratio,
        `${label} ${fg} on ${bg} = ${ratio.toFixed(2)}:1 (need ${AA_NORMAL})`,
      ).toBeGreaterThanOrEqual(AA_NORMAL)
    })
  }

  it('preserves the gray tier order: muted lighter than secondary lighter than slate500', () => {
    expect(relLuminance(color.textMuted)).toBeGreaterThan(relLuminance(color.textSecondary))
    expect(relLuminance(color.textSecondary)).toBeGreaterThan(relLuminance(color.textSlate500))
  })
})
