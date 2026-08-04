import type { SVGProps } from 'react'
import { LOGO_MARK } from './logo'
import { color } from './tokens'

/**
 * The FloorVote hemicycle mark (v1.1 — filled ring-segments). Geometry is the
 * single source `shared/logo.ts`; this is just a thin renderer. Defaults to the
 * Honey fill and the framed viewBox; pass `inline` for the tight lockup crop,
 * whose bottom edge is the legs so `vertical-align: baseline` seats them on the
 * text baseline.
 */
export function LogoMark({ fill = color.accentAmber, inline = false, ...rest }: { fill?: string; inline?: boolean } & SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox={inline ? LOGO_MARK.inlineViewBox : LOGO_MARK.viewBox}
      fill={fill}
      role="img"
      aria-label="FloorVote"
      {...rest}
    >
      {LOGO_MARK.paths.map((d, i) => (
        <path key={i} d={d} />
      ))}
    </svg>
  )
}
