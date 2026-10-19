import { describe, it, expect } from 'vitest'
import { claimGlow, CLAIM_GLOW } from './claimGlow'

// The glow on a claim's quote preview and the PDF quote box (#696). The mockup
// it was picked from used a 3px halo ring, a 16px blur, and a 28px blur for the
// box's arrival flash. Will asked for it about 20% subtler: opacity (the tokens,
// tested in styles/tokens.test.ts) and spread both scaled down by a fifth.
describe('claim glow', () => {
  it('scales the mockup\'s spreads down by a fifth', () => {
    expect(CLAIM_GLOW.haloSpread).toBeCloseTo(3 * 0.8, 5)
    expect(CLAIM_GLOW.blur).toBeCloseTo(16 * 0.8, 5)
    expect(CLAIM_GLOW.flashBlur).toBeCloseTo(28 * 0.8, 5)
  })

  it('builds the resting glow from the tokens: a Honey border, a halo ring, a blur, and the floating shadow', () => {
    expect(claimGlow.border).toBe('1px solid var(--fv-claim-glow-border)')
    expect(claimGlow.boxShadow).toBe(`0 0 0 ${CLAIM_GLOW.haloSpread}px var(--fv-claim-glow-halo), 0 0 ${CLAIM_GLOW.blur}px var(--fv-claim-glow-blur), 0 2px 8px rgba(0,0,0,0.08)`)
  })

  it('sits on the card surface, which follows the color mode', () => {
    expect(claimGlow.background).toBe('var(--fv-white)')
  })

  it('writes no color literal other than the shadow tier\'s own', () => {
    expect(`${claimGlow.border} ${claimGlow.background}`).not.toMatch(/#[0-9a-f]{3,8}|rgb/i)
  })
})
