// Shared "flip" decision for the two BillList filter-bar menus (FilterDropdown,
// SubjectFilterDropdown). Both position their menu as
// `position: absolute; top: calc(100% + 4px)` relative to a wrapper that is
// exactly as wide as the trigger button, and both default to `left: 0` —
// which opens the menu off the right edge of the window when the trigger
// sits near it. The fix is the conventional flip: when the menu would
// overflow the viewport's right edge, anchor its right edge to the trigger's
// right edge (`right: 0` on the same wrapper) instead of its left edge.
//
// This lives in one place, used by both dropdowns, rather than duplicated in
// each: the arithmetic is identical, and the SubjectFilterDropdown case adds
// one wrinkle (its panel width changes via drag-resize) that a single
// well-tested helper handles once instead of twice.
export type MenuAlign = 'left' | 'right'

// Keep a small margin off the viewport edge, matching HoverTooltip's clamp
// margin elsewhere in this codebase.
const VIEWPORT_MARGIN = 8

/**
 * Pure decision: given the trigger button's rect and the menu's width (either
 * measured from the rendered DOM, or — for a panel with a controlled width,
 * like SubjectFilterDropdown's drag-resizable one — passed directly), decide
 * which edge the menu should align to.
 *
 * `menuWidth <= 0` (not yet measured, e.g. the menu hasn't rendered/laid out
 * yet) always resolves to 'left', the existing default — nothing to flip
 * against until there's a real width.
 */
export function resolveMenuAlign(
  triggerRect: { left: number },
  menuWidth: number,
  viewportWidth: number,
): MenuAlign {
  if (menuWidth <= 0) return 'left'
  return triggerRect.left + menuWidth > viewportWidth - VIEWPORT_MARGIN ? 'right' : 'left'
}
