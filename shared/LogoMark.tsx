import type { SVGProps } from 'react'
import { LOGO_MARK } from './logo'
import { color } from './tokens'

/**
 * The FloorVote hemicycle mark. Geometry is the single source `shared/logo.ts`;
 * this is just a thin renderer. Defaults to the Honey stroke.
 */
export function LogoMark({ stroke = color.accentAmber, ...rest }: { stroke?: string } & SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox={LOGO_MARK.viewBox}
      fill="none"
      stroke={stroke}
      strokeWidth={LOGO_MARK.strokeWidth}
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
