/**
 * True when a click should bypass SPA navigation and let the browser do its
 * native thing (open in a new tab / window). Covers ⌘ (macOS), Ctrl
 * (Windows/Linux), Shift, and any non-primary mouse button (e.g. middle-click).
 *
 * Every in-app nav entry point (sidebar links, bill chips, cards, rows) guards
 * with this BEFORE calling preventDefault()/navigate(), so modified clicks fall
 * through to the underlying <a href> instead of being swallowed by the SPA.
 */
export function isModifiedClick(e: {
  metaKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
  button: number
}): boolean {
  return e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0
}

/**
 * New-tab shim for pseudo-links — `role="link"` spans/divs that can't be a real
 * <a href> (e.g. a count chip nested inside another anchor, where a nested <a>
 * would be invalid HTML). For a modified/middle click, opens `to` in a new tab
 * and stops the event (so it doesn't also trigger the SPA handler or bubble to
 * a parent link), returning true. For a plain click, does nothing and returns
 * false so the caller runs its normal in-app navigation.
 */
export function maybeOpenInNewTab(
  e: {
    metaKey: boolean
    ctrlKey: boolean
    shiftKey: boolean
    button: number
    preventDefault: () => void
    stopPropagation: () => void
  },
  to: string,
): boolean {
  if (!isModifiedClick(e)) return false
  e.preventDefault()
  e.stopPropagation()
  window.open(to, '_blank', 'noopener')
  return true
}
