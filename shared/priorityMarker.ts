import { PRIORITY_COLORS } from './billChipColors'

// The priority marker — a small filled rounded square shared by every surface
// that shows a bill's priority: the web BillBadge and Feed (drawn as an
// inline SVG <rect>, see PrioritySquare.tsx) and the week-ahead email (a
// border-radius span, since email clients strip SVG). The two render targets
// can't share a component, so they share this spec instead — the same way
// eventLineModel is shared between Feed and the email for bill-update lines.
// Keep the geometry/halo here so the surfaces never drift.

export type PriorityLevel = 'high' | 'medium' | 'low'

/** White halo so the square reads on a dark chip (navy BillBadge); omit it on
 *  light backgrounds (the Feed row). */
export const PRIORITY_MARKER_RING = '0 0 0 1.5px rgba(255,255,255,0.9)'

/** Corner radius for a priority square of side `size` — ~1/5 of the side,
 *  floored at 2px, giving the same gently-rounded corner at every scale. */
export function prioritySquareRadius(size: number): number {
  return Math.max(2, Math.round(size / 5))
}

/** Resolved marker style for one priority level. Consumers render their own box
 *  from it: the web draws an SVG <rect>, the email serializes a span. */
export interface PriorityMarkerSpec {
  size: number
  radius: number
  fill: string
  ring: string | null
}

export function priorityMarkerSpec(
  priority: PriorityLevel,
  opts: { size: number; ring: boolean },
): PriorityMarkerSpec {
  return {
    size: opts.size,
    radius: prioritySquareRadius(opts.size),
    fill: PRIORITY_COLORS[priority].dot,
    ring: opts.ring ? PRIORITY_MARKER_RING : null,
  }
}
