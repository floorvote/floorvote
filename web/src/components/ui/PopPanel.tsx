import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { CSSProperties, ReactNode, Ref, RefObject } from 'react'
import { color, radius, shadow } from '../../styles/tokens'
import { usePrefersReducedMotion } from '../../lib/usePrefersReducedMotion'
import { useFocusTrap } from '../../lib/useFocusTrap'
import type { Box } from '../calendar/expandTarget'

export interface PopPanelHandle { close: () => void }

interface PopPanelProps {
  /** Called AFTER the exit animation completes so the parent can unmount. */
  onClose: () => void
  /** Fixed-position styles (top/left/bottom/width/maxHeight, plus any layout like display/flexDirection). */
  positionStyle: CSSProperties
  /** CSS transform-origin for the spring, e.g. 'top left' | 'bottom left'. */
  transformOrigin: string
  /** Initial translateY offset (px) for the spring. Default -6; use +6 for a bottom-origin pop-up. */
  enterOffsetY?: number
  /** Element excluded from outside-click dismissal (the trigger), so the trigger owns toggle. */
  triggerRef?: RefObject<HTMLElement | null>
  ariaLabel?: string
  /** Opt-in expand mode: the trigger card's start rect. When set (with
   *  computeTarget), the panel springs from this rect to the target box
   *  instead of the scale spring. */
  expandFrom?: DOMRect
  /** Given the panel's measured natural height, returns the target box. */
  computeTarget?: (naturalHeight: number) => Box
  /** Padding to animate during expand (card padding → panel padding). */
  expandPadding?: { from: string; to: string }
  /** Panel background (default white); expand uses a faint tint. */
  background?: string
  /** Override the panel corner radius. Defaults to expand?radius.md:radius.xl. */
  cornerRadius?: number
  /** Position-only clamp for grow panels: given the panel's measured natural
   *  height, returns the clamped {left, top}. Applied in a layout effect before
   *  paint. Keeps the scale-spring + grow rendering (no FLIP, no overflow clip).
   *  Ignored when expandFrom is set. */
  clampPosition?: (naturalHeight: number) => { left: number; top: number }
  children: ReactNode
}

// Matches the spring transition duration; safety net for environments where
// transitionend doesn't fire (e.g. prefers-reduced-motion).
const EXIT_MS = 280

export function PopPanel(
  {
    onClose,
    positionStyle,
    transformOrigin,
    enterOffsetY = -6,
    triggerRef,
    ariaLabel,
    expandFrom,
    computeTarget,
    expandPadding = { from: '3px 6px', to: '12px' },
    background = color.white,
    cornerRadius,
    clampPosition,
    children,
    ref,
  }: PopPanelProps & { ref?: Ref<PopPanelHandle> },
) {
  const [visible, setVisible] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const closingRef = useRef(false)
  const doneRef = useRef(false)

  useFocusTrap({ active: true, containerRef: panelRef, initialFocus: 'first' })

  const reduce = usePrefersReducedMotion()
  const expand = !!(expandFrom && computeTarget)
  const SPRING = 'cubic-bezier(0.34, 1.56, 0.64, 1)'
  const expandTrans = (d = 0.26) =>
    `top ${d}s ${SPRING}, left ${d}s ${SPRING}, width ${d}s ${SPRING}, height ${d}s ${SPRING}, padding ${d}s ${SPRING}, box-shadow 0.2s ease`

  const finish = useCallback(() => {
    if (doneRef.current) return
    doneRef.current = true
    onCloseRef.current()
  }, [])

  const beginClose = useCallback(() => {
    if (closingRef.current) return
    closingRef.current = true
    const el = panelRef.current
    if (expand && el && expandFrom) {
      if (reduce) { finish(); return }
      el.style.transition = expandTrans(0.2)
      el.style.left = `${expandFrom.left}px`; el.style.top = `${expandFrom.top}px`
      el.style.width = `${expandFrom.width}px`; el.style.height = `${expandFrom.height}px`
      el.style.padding = expandPadding.from
      el.style.boxShadow = 'none'
      window.setTimeout(finish, EXIT_MS)
      return
    }
    setVisible(false)
    window.setTimeout(finish, EXIT_MS)
  }, [finish, expand, expandFrom, expandPadding, reduce])

  useImperativeHandle(ref, () => ({ close: beginClose }), [beginClose])

  // Default scale-spring: spring in on the next frame. Skipped in expand mode.
  useEffect(() => {
    if (expand) return
    const id = requestAnimationFrame(() => setVisible(true))
    return () => cancelAnimationFrame(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Expand mode (FLIP): measure natural height at target width, snap to the
  // card's rect, then spring top/left/width/height/padding to the target box.
  useLayoutEffect(() => {
    if (!expand) return
    const el = panelRef.current
    if (!el || !expandFrom || !computeTarget) return
    const r = expandFrom
    el.style.boxSizing = 'border-box'
    el.style.width = `${computeTarget(0).width}px`
    el.style.padding = expandPadding.to
    el.style.height = 'auto'
    const target = computeTarget(el.offsetHeight)
    if (reduce) {
      el.style.left = `${target.left}px`; el.style.top = `${target.top}px`
      el.style.width = `${target.width}px`; el.style.height = `${target.height}px`
      return
    }
    el.style.transition = 'none'
    el.style.left = `${r.left}px`; el.style.top = `${r.top}px`
    el.style.width = `${r.width}px`; el.style.height = `${r.height}px`
    el.style.padding = expandPadding.from
    void el.offsetWidth
    const rafId = requestAnimationFrame(() => {
      el.style.transition = expandTrans()
      el.style.left = `${target.left}px`; el.style.top = `${target.top}px`
      el.style.width = `${target.width}px`; el.style.height = `${target.height}px`
      el.style.padding = expandPadding.to
    })
    return () => cancelAnimationFrame(rafId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expand])

  // Position-only clamp for grow panels (forms): measure natural height, then
  // clamp left/top before paint. No FLIP, no overflow clip — scale-spring + grow
  // are untouched, so the bill-picker dropdown still escapes the panel.
  // positionStyle.left/top is the pre-clamp starting point; this overrides it
  // before first paint (no flash). One-shot: the panel remounts per open (key),
  // so a changed clampPosition identity arrives via remount, not a re-run — hence [].
  useLayoutEffect(() => {
    if (expand || !clampPosition) return
    const el = panelRef.current
    if (!el) return
    const { left, top } = clampPosition(el.offsetHeight)
    el.style.left = `${left}px`
    el.style.top = `${top}px`
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Dismiss on outside pointerdown (excluding the trigger) + Escape.
  useEffect(() => {
    function onPointerDown(e: PointerEvent) {
      const target = e.target as Node
      if (panelRef.current?.contains(target)) return
      if (triggerRef?.current?.contains(target)) return
      beginClose()
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') beginClose()
    }
    document.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [beginClose, triggerRef])

  // Portal to <body> so the panel's `position: fixed` resolves against the
  // viewport, not a transformed/overflow-clipped ancestor (e.g. the mobile
  // sidebar drawer, which has `transform` + `overflow`). callers pass
  // viewport-relative coordinates, so this is the correct anchor for all uses.
  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      aria-label={ariaLabel}
      tabIndex={-1}
      onTransitionEnd={(e) => { if (e.target === panelRef.current && e.propertyName === 'transform' && closingRef.current) finish() }}
      style={{
        background,
        borderRadius: cornerRadius ?? (expand ? radius.md : radius.xl),
        boxShadow: shadow.lg,
        zIndex: 500,
        ...(expand
          ? {
              // expandFrom values are the initial snap rect; live animation runs via el.style.
              // A changed start rect must arrive via remount (new key), not a re-render.
              position: 'fixed' as const, overflow: 'hidden', boxSizing: 'border-box' as const,
              left: `${expandFrom!.left}px`, top: `${expandFrom!.top}px`,
              width: `${expandFrom!.width}px`, height: `${expandFrom!.height}px`,
            }
          : {
              transformOrigin,
              transform: visible ? 'scale(1) translateY(0)' : `scale(0.82) translateY(${enterOffsetY}px)`,
              opacity: visible ? 1 : 0,
              transition: 'transform 0.24s cubic-bezier(0.34, 1.56, 0.64, 1), opacity 0.14s ease',
              ...positionStyle,
            }),
      }}
    >
      {children}
    </div>,
    document.body,
  )
}
