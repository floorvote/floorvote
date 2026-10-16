import { color, fontSize, BRAND_FONT } from './tokens'
import { PRODUCT_NAME_WORDMARK } from './brand'
import { LOGO_LOCKUP } from './logo'
import { LogoMark } from './LogoMark'

interface WordmarkProps {
  /** White "Floor" for the navy brand chrome (sidebar, mobile bar). Otherwise "Floor"
   *  is navy on the light page and white on the dark one (wordmarkFloor). */
  dark?: boolean
  /** Font size in px. Defaults to the wordmark size used on the login/sign-in pages. */
  size?: number
}

/**
 * The product lockup: the hemicycle mark + "Floor" (navy on light, white on dark)
 * + "Vote" (Honey). Honey and the mark are the same in both color modes. Mark geometry and lockup metrics come from the single source
 * `shared/logo.ts`; the two text parts from `shared/brand.ts`.
 *
 * v1.1 places the mark by the brand-kit recipe: the inline (tight) mark at
 * `markHeightEm` (1.02 × cap), `vertical-align: baseline` seating its legs on the
 * text baseline, and the mark→name gap as a right margin — no optical nudge.
 */
export function Wordmark({ dark = false, size = fontSize.xxxl }: WordmarkProps) {
  return (
    <span
      style={{
        display: 'inline-block',
        fontFamily: BRAND_FONT,
        fontWeight: LOGO_LOCKUP.weight,
        fontSize: size,
        letterSpacing: LOGO_LOCKUP.letterSpacing,
        lineHeight: 1,
        whiteSpace: 'nowrap',
      }}
    >
      <LogoMark
        inline
        style={{ height: `${LOGO_LOCKUP.markHeightEm}em`, width: 'auto', verticalAlign: 'baseline', marginRight: `${LOGO_LOCKUP.gapEm}em` }}
      />
      <span>
        <span style={{ color: dark ? color.textOnBrand : color.wordmarkFloor }}>{PRODUCT_NAME_WORDMARK.primary}</span>
        <span style={{ color: color.accentAmber }}>{PRODUCT_NAME_WORDMARK.accent}</span>
      </span>
    </span>
  )
}
