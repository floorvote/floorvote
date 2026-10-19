import { color, shadow } from '../styles/tokens'

// The glow that marks a claim's quote, wherever it shows: the hover and focus
// preview over the summary, and the quote box above a PDF (#696). A Honey
// border, a faint Honey ring, a soft Honey blur, and the standard floating
// shadow, on the card surface. The strengths are tokens (claimGlow*, with a
// light and a dark value). The mockup the design was picked from spread the
// ring 3px and the blur 16px, with a 28px blur as the box arrives; Will asked
// for the glow about 20% subtler, so these spreads are those, less a fifth.
export const CLAIM_GLOW = { haloSpread: 2.4, blur: 12.8, flashBlur: 22.4 } as const

export const claimGlow = {
  background: color.white,
  border: `1px solid ${color.claimGlowBorder}`,
  boxShadow: `0 0 0 ${CLAIM_GLOW.haloSpread}px ${color.claimGlowHalo}, 0 0 ${CLAIM_GLOW.blur}px ${color.claimGlowBlur}, ${shadow.md}`,
} as const

/** The box-shadow the quote box starts its arrival from, before it settles to `claimGlow.boxShadow`. */
export const CLAIM_GLOW_FLASH = `0 0 0 ${CLAIM_GLOW.haloSpread}px ${color.claimFlashHalo}, 0 0 ${CLAIM_GLOW.flashBlur}px ${color.claimFlashBlur}, ${shadow.md}`
