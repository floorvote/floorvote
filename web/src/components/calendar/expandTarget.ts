// web/src/components/calendar/expandTarget.ts

/** A viewport-fixed box in CSS px. */
export interface Box { left: number; top: number; width: number; height: number }

export interface ExpandInputs {
  /** The clicked event card's rect (viewport coords). `width`/`height` are
   *  carried so callers can pass a DOMRect-shaped object directly, even though
   *  the geometry below only reads `left`/`top`. */
  card: { left: number; top: number; width: number; height: number }
  /** Calendar grid bounds (viewport coords). */
  calLeft: number
  calRight: number
  calTop: number
  /** Bottom (viewport coord) of the last week containing in-month days. */
  activeBottom: number
  /** Inset the right/bottom clamps by this many px (the gap an event sits in
   *  from its cell edge: cell padding + border ≈ 7). */
  pad: number
  /** Expanded panel width. Default 320. */
  width?: number
}

/**
 * The box the card expands into. Grows rightward from the card's left by
 * default; pins its right edge to `calRight - pad` (growing leftward) only when
 * it would otherwise pass the calendar's right edge. The title line stays
 * anchored at `card.top` unless the box would extend past `activeBottom - pad`,
 * in which case it lifts up to fit. Never extends past the calendar bounds.
 */
export function computeExpandTarget(inp: ExpandInputs, naturalHeight: number): Box {
  const width = inp.width ?? 320

  let left = inp.card.left
  if (left + width > inp.calRight - inp.pad) left = inp.calRight - inp.pad - width
  left = Math.max(inp.calLeft, left)

  let top = inp.card.top
  const floor = inp.activeBottom - inp.pad
  if (top + naturalHeight > floor) top = floor - naturalHeight
  top = Math.max(inp.calTop, top)

  return { left, top, width, height: naturalHeight }
}
