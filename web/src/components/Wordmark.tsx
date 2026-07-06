import { color, fontSize, fontWeight, BRAND_FONT } from '../styles/tokens'
import { PRODUCT_NAME_WORDMARK } from '../../../shared/brand'

interface WordmarkProps {
  /** White "Floor" for dark backgrounds (navy sidebar/mobile bar); navy otherwise. */
  dark?: boolean
  /** Font size in px. Defaults to the wordmark size used on the login/sign-in pages. */
  size?: number
}

/**
 * The product wordmark: "Floor" (navy on light, white on dark) + "Vote" (always
 * the logo orange). The two parts come from the single brand source of truth.
 */
export function Wordmark({ dark = false, size = fontSize.xl }: WordmarkProps) {
  return (
    <span style={{ fontFamily: BRAND_FONT, fontWeight: fontWeight.heavy, fontSize: size, letterSpacing: '-0.02em' }}>
      <span style={{ color: dark ? color.white : color.billBadgeNavy }}>{PRODUCT_NAME_WORDMARK.primary}</span>
      <span style={{ color: color.accentAmber }}>{PRODUCT_NAME_WORDMARK.accent}</span>
    </span>
  )
}
