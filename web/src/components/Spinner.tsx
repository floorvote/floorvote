import type { SVGProps } from 'react'
import { LOGO_MARK } from '../../../shared/logo'
import { color } from '../styles/tokens'

/**
 * FloorVote brand loading spinner — the hemicycle mark in "Gyro" motion: the
 * three seating rows counter-rotate and drift out of phase, then decelerate and
 * hold on the aligned logo pose for a beat before scattering again.
 *
 * Geometry is the single source of truth in `shared/logo.ts` (the exact paths
 * <LogoMark> draws), so this never diverges from the brand mark. Reads best at
 * 24px and up — below that the three concentric rows visually merge.
 *
 * Not wired into any screen yet; drop it in wherever a load state lives:
 *   <Spinner />                       // 40px, Honey (brand amber)
 *   <Spinner size={24} />             // smaller / inline
 *   <Spinner stroke={color.accentBlue} aria-label="Searching" />
 *
 * Honors `prefers-reduced-motion` by freezing on the aligned logo pose.
 */

const GYRO = ['fvGyroOuter', 'fvGyroMid', 'fvGyroInner'] as const

// Whole-turn counts in alternating directions so all three rows land back at
// 0deg together (the aligned logo) and hold there over 80–100% of the cycle.
const SPINNER_CSS = `
@keyframes fvGyroOuter{0%{transform:rotate(0)}80%,100%{transform:rotate(720deg)}}
@keyframes fvGyroMid{0%{transform:rotate(0)}80%,100%{transform:rotate(-1080deg)}}
@keyframes fvGyroInner{0%{transform:rotate(0)}80%,100%{transform:rotate(1440deg)}}
@media (prefers-reduced-motion: reduce){.fv-spinner path{animation:none!important}}
`

export function Spinner({
  size = 40,
  stroke = color.accentAmber,
  className,
  style,
  'aria-label': ariaLabel = 'Loading',
  ...rest
}: {
  size?: number | string
  stroke?: string
} & Omit<SVGProps<SVGSVGElement>, 'width' | 'height'>) {
  return (
    <>
      {/* React 19 hoists + dedupes this by href, so N spinners inject it once. */}
      <style href="floorvote-spinner" precedence="default">
        {SPINNER_CSS}
      </style>
      <svg
        className={['fv-spinner', className].filter(Boolean).join(' ')}
        width={size}
        height={size}
        // Square window on the mark; overflow:visible lets the rows sweep past
        // the box while spinning without clipping.
        viewBox="17 13.6 66 66"
        fill="none"
        stroke={stroke}
        strokeWidth={LOGO_MARK.strokeWidth}
        role="img"
        aria-label={ariaLabel}
        style={{ overflow: 'visible', ...style }}
        {...rest}
      >
        {LOGO_MARK.paths.map((d, i) => (
          <path
            key={i}
            d={d}
            style={{
              transformBox: 'view-box',
              transformOrigin: '50px 55.635px', // exact centre of the mark
              animation: `${GYRO[i]} 2.7s ease-in-out infinite`,
            }}
          />
        ))}
      </svg>
    </>
  )
}
