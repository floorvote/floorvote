import { useEffect, useRef } from 'react'

/**
 * Dismiss a popover when a mousedown lands outside it. Attach the returned ref
 * to the element that should NOT dismiss — typically the wrapper holding both
 * the trigger and the menu, so clicking the trigger to close does not fight
 * this listener.
 *
 * Extracted rather than duplicated because two popovers in this feature need
 * it, matching how useMenuAlign is shared across the filter dropdowns.
 * `onDismiss` is read through a ref so a caller passing an inline arrow does
 * not re-subscribe the listener on every render.
 */
export function useDismissOnOutsideClick(active: boolean, onDismiss: () => void) {
  const ref = useRef<HTMLDivElement>(null)
  const handler = useRef(onDismiss)
  useEffect(() => { handler.current = onDismiss }, [onDismiss])

  useEffect(() => {
    if (!active) return
    function onMouseDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) handler.current()
    }
    document.addEventListener('mousedown', onMouseDown)
    return () => document.removeEventListener('mousedown', onMouseDown)
  }, [active])

  return ref
}
