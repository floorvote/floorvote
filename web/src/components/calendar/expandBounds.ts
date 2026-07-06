import { computeExpandTarget, type Box } from './expandTarget'

/**
 * Given an anchor element inside the month grid (an event card or a day cell)
 * and the rect the popover should grow from, returns a `computeExpandTarget`
 * closure over the calendar's bounds — or null if the element is not inside a
 * `[data-calgrid]` cell. The closure clamps to the calendar's right edge and to
 * the bottom of the last in-month week, inset by the cell's own padding+border
 * (`pad`, ~7px). Shared by the event expand and the form popovers.
 */
export function clampTargetFor(
  el: HTMLElement | null,
  anchor: { left: number; top: number; width: number; height: number },
): ((naturalHeight: number) => Box) | null {
  const grid = el?.closest('[data-calgrid]') as HTMLElement | null
  const cell = el?.closest('[data-daycell]') as HTMLElement | null
  if (!el || !grid || !cell) return null
  const calRect = grid.getBoundingClientRect()
  const cs = getComputedStyle(cell)
  // pad = cell's intrinsic content inset (padding + border). Measured from the cell rather than
  // from anchor.left - cell.left so it's correct for slot-anchored form popovers (anchor sits at
  // the cell edge, not inset like an event card). Equals ~7px for both cases.
  const pad = Math.round(parseFloat(cs.paddingLeft || '0') + parseFloat(cs.borderLeftWidth || '0'))
  const inMonthCells = Array.from(grid.querySelectorAll('[data-daycell][data-inmonth="1"]')) as HTMLElement[]
  const activeBottom = inMonthCells.length
    ? Math.max(...inMonthCells.map(c => c.getBoundingClientRect().bottom))
    : calRect.bottom
  const card = { left: anchor.left, top: anchor.top, width: anchor.width, height: anchor.height }
  return (naturalHeight: number) =>
    computeExpandTarget({ card, calLeft: calRect.left, calRight: calRect.right, calTop: calRect.top, activeBottom, pad }, naturalHeight)
}
