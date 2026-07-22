import { useEffect, useRef } from 'react'

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

// Ref-count so stacked dialogs share one inert toggle on #root.
let inertCount = 0

interface Options {
  active: boolean
  containerRef: React.RefObject<HTMLElement | null>
  onEscape?: () => void
  initialFocus?: 'first' | 'container' | React.RefObject<HTMLElement | null>
  /**
   * Inert a specific element instead of the default `#root`. Dialogs/PopPanels
   * portal to `document.body` (siblings of `#root`), so inerting `#root` is
   * safe for them. But some trapped containers (e.g. the mobile nav drawer)
   * render IN-TREE inside `#root` — inerting `#root` would inert the drawer
   * itself, making it unfocusable. Pass the sibling content to inert instead
   * (e.g. the `<main>` behind the drawer). Single-owner: not ref-counted like
   * the `#root` default, since exactly one active trap is expected to target
   * a given element at a time; guarded so cleanup only clears attributes this
   * activation actually set.
   */
  inertTarget?: React.RefObject<HTMLElement | null>
}

export function useFocusTrap({ active, containerRef, onEscape, initialFocus = 'first', inertTarget }: Options): void {
  const restoreRef = useRef<HTMLElement | null>(null)
  const onEscapeRef = useRef(onEscape)
  onEscapeRef.current = onEscape

  useEffect(() => {
    if (!active) return
    // #root path only applies when no explicit inertTarget is given — the
    // existing ref-counted #root behavior (Dialog/PopPanel) is otherwise
    // untouched.
    const root = inertTarget ? null : (typeof document !== 'undefined' ? document.getElementById('root') : null)
    const inertTargetEl = inertTarget ? inertTarget.current : null
    restoreRef.current = (document.activeElement as HTMLElement) ?? null

    // Move focus in.
    const container = containerRef.current
    if (container) {
      let target: HTMLElement | null = null
      if (initialFocus === 'container') target = container
      else if (initialFocus && initialFocus !== 'first') target = initialFocus.current
      else target = container.querySelector<HTMLElement>(FOCUSABLE)
      ;(target ?? container).focus()
    }

    // Inert the rest of the app (dialogs portal to body, siblings of #root) —
    // or, when inertTarget is given, inert that element instead.
    let clearedInertTarget = false
    if (root) {
      inertCount++
      root.setAttribute('inert', '')
      root.setAttribute('aria-hidden', 'true')
    } else if (inertTargetEl) {
      inertTargetEl.setAttribute('inert', '')
      inertTargetEl.setAttribute('aria-hidden', 'true')
    }

    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onEscapeRef.current?.()
    }
    document.addEventListener('keydown', onKey)

    return () => {
      document.removeEventListener('keydown', onKey)
      if (root) {
        inertCount = Math.max(0, inertCount - 1)
        if (inertCount === 0) {
          root.removeAttribute('inert')
          root.removeAttribute('aria-hidden')
        }
      } else if (inertTargetEl && !clearedInertTarget) {
        clearedInertTarget = true
        inertTargetEl.removeAttribute('inert')
        inertTargetEl.removeAttribute('aria-hidden')
      }
      // Only restore focus if it hasn't already moved to some other element
      // outside this (now-unmounting) container. Without this guard, when
      // one trap deactivates in the same commit that mounts a replacement
      // (e.g. Calendar.tsx swapping popovers via `key={token}`), the outgoing
      // trap's cleanup would yank focus off the element the user just
      // activated and back onto its own stale restore target.
      const el = document.activeElement
      const focusStillInsideOrLoose = !el || el === document.body || (container ? container.contains(el) : false)
      if (focusStillInsideOrLoose) restoreRef.current?.focus?.()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active])
}
