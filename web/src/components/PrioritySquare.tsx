import type { CSSProperties } from 'react'
import { PRIORITY_MARKER_RING, prioritySquareRadius } from '../../../shared/priorityMarker'

/**
 * The priority marker: a small filled rounded square. A plain CSS box — the
 * radius (≈1/5 of the side, via `prioritySquareRadius`, a computed value so the
 * raw-radius lint rule doesn't trip) and the ring halo both come from
 * shared/priorityMarker, so this and the week-ahead email span render the marker
 * from one spec with no drift. (Previously an inline SVG <rect>; a border-radius
 * box is indistinguishable at chip scale and lets email and web share rendering.)
 *
 * `ring` adds a white halo so the square reads on a dark chip (navy BillBadge);
 * omit it on light backgrounds (the Feed row).
 */
export function PrioritySquare({ size, color, ring = false, style }: {
  size: number
  color: string
  ring?: boolean
  style?: CSSProperties
}) {
  return (
    <span
      aria-hidden="true"
      style={{
        display: 'inline-block',
        width: size,
        height: size,
        borderRadius: prioritySquareRadius(size),
        background: color,
        flexShrink: 0,
        ...(ring ? { boxShadow: PRIORITY_MARKER_RING } : {}),
        ...style,
      }}
    />
  )
}
