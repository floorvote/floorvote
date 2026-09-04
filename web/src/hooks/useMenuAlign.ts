import { useLayoutEffect, useState } from 'react'
import type { RefObject } from 'react'
import { resolveMenuAlign, type MenuAlign } from '../lib/menuAlign'

/**
 * Re-derives which edge a filter-bar menu (FilterDropdown, SubjectFilterDropdown)
 * should align to, every time it opens or its width changes — never a
 * one-shot decision cached from mount, so a panel that changes width after
 * opening (SubjectFilterDropdown's drag-to-resize handle) doesn't get stuck
 * with a flip decision made for its old width.
 *
 * `width`: pass the panel's own controlled width when the caller already
 * tracks one (SubjectFilterDropdown's `panelWidth` state) — no DOM
 * measurement needed, and the caller's width state already changes on
 * resize, so including it as a hook input covers that case for free. Omit it
 * (FilterDropdown, whose menu's width is intrinsic to its content and only
 * knowable once rendered) to have the hook measure `menuRef` itself via
 * layout effect, before paint, so there is no visible left-then-right jump.
 */
export function useMenuAlign(
  open: boolean,
  triggerRef: RefObject<HTMLElement | null>,
  menuRef?: RefObject<HTMLElement | null>,
  width?: number,
): MenuAlign {
  const [align, setAlign] = useState<MenuAlign>('left')

  useLayoutEffect(() => {
    if (!open) return
    const trigger = triggerRef.current
    if (!trigger) return

    const measure = () => {
      const menuWidth = width ?? menuRef?.current?.getBoundingClientRect().width ?? 0
      setAlign(resolveMenuAlign(trigger.getBoundingClientRect(), menuWidth, window.innerWidth))
    }
    measure()

    // The window can be resized while the menu is open; re-derive rather than
    // leaving a stale side in place.
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, width])

  return align
}
