import { color, fontSize, BRAND_FONT } from '../styles/tokens'
import { PRODUCT_NAME_WORDMARK } from '../../../shared/brand'
import { LOGO_LOCKUP } from '../../../shared/logo'
import { LogoMark } from './LogoMark'

interface WordmarkProps {
  /** White "Floor" for dark backgrounds (navy sidebar/mobile bar); navy otherwise. */
  dark?: boolean
  /** Font size in px. Defaults to the wordmark size used on the login/sign-in pages. */
  size?: number
}

/**
 * The product lockup: the hemicycle mark + "Floor" (navy on light, white on dark)
 * + "Vote" (Honey). Mark geometry and lockup metrics come from the single source
 * `shared/logo.ts`; the two text parts from `shared/brand.ts`.
 */
export function Wordmark({ dark = false, size = fontSize.xl }: WordmarkProps) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: `${LOGO_LOCKUP.gapEm}em`,
        fontFamily: BRAND_FONT,
        fontWeight: LOGO_LOCKUP.weight,
        fontSize: size,
        letterSpacing: LOGO_LOCKUP.letterSpacing,
        lineHeight: 1,
      }}
    >
      <LogoMark style={{ height: `${LOGO_LOCKUP.markHeightEm}em`, width: 'auto', flex: '0 0 auto' }} />
      <span>
        <span style={{ color: dark ? color.white : color.billBadgeNavy }}>{PRODUCT_NAME_WORDMARK.primary}</span>
        <span style={{ color: color.accentAmber }}>{PRODUCT_NAME_WORDMARK.accent}</span>
      </span>
    </span>
  )
}
