import { useId, useState, useRef, type ReactNode, type RefObject, type PointerEvent as ReactPointerEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { TOOLTIP_STYLE, tooltipPosition, tooltipPositionBelow, tooltipPositionRight } from '../lib/chipStyles'

export type Placement = 'top' | 'top-start' | 'top-end' | 'bottom' | 'bottom-start' | 'right'

// One hover tooltip for all white-bubble cases. Behavior collected from the
// three components it replaces:
//  - anchor measured on hover via getBoundingClientRect (HoverTip/InfoTooltip)
//  - pointer events with a mouse-only guard so a tap can't strand the bubble
//    (FilterTooltip) — a touch fires pointerenter with no matching leave
//  - optional portal to document.body so an ancestor's overflow/transform can't
//    clip it (HoverTip — calendar popovers)
//  - optional maxWidth to opt into a wrapping multi-line bubble (FilterTooltip)
//  - unified `placement`: 'top' centers above; 'top-start'/'top-end' align the
//    bubble's left/right edge to the anchor (InfoTooltip's old left/right align);
//    'bottom' centers below; 'bottom-start' sits left-aligned below; 'right' sits
//    beside, falling back to below when the viewport is too narrow (FilterTooltip).
//
// Two archetypes, selected by `toggletip`:
//  - Default (toggletip=false) — interactive-element tooltip. `children` is
//    already an interactive element (button, link, etc.) with its own
//    aria-label; the wrapper stays a plain span/div, exactly as before, so
//    every existing consumer is visually and structurally unchanged. The only
//    addition is onFocus/onBlur on the wrapper — React focus events bubble, so
//    they fire when the focusable child receives/loses focus — which reveals
//    the bubble for keyboard users the same way hover reveals it for mouse
//    users. The bubble here is a purely visual affordance (aria-hidden): the
//    child's own aria-label already carries the accessible name.
//  - toggletip=true — standalone toggletip, for non-interactive triggers (ⓘ
//    icons, static chips with no action of their own). `children` is rendered
//    inside a real <button type="button">. Reveals on hover (mouse) + focus +
//    click-toggle; hides on Escape/blur/second-click. The bubble gets an id +
//    role="tooltip" and the button gets a matching aria-describedby.
interface HoverTooltipProps {
  text: ReactNode
  children: ReactNode
  placement?: Placement
  maxWidth?: number
  portal?: boolean
  // Make the hover target fill its container (block wrapper, width 100%) instead
  // of shrink-wrapping the children — so a whole row is hoverable, not just its
  // text.
  block?: boolean
  // For 'top' placement: also clamp the bubble's right edge to this element's
  // right edge (not just the viewport), so a wide bubble centered on a control
  // near a card's edge can't spill past that card.
  boundaryRef?: RefObject<HTMLElement | null>
  // Opt-in standalone toggletip archetype — see file header. Default false
  // keeps today's exact wrapper/behavior so untouched consumers are unaffected.
  toggletip?: boolean
}

export function HoverTooltip({ text, children, placement = 'top', maxWidth, portal = false, block = false, boundaryRef, toggletip = false }: HoverTooltipProps) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null)
  const ref = useRef<HTMLElement | null>(null)
  // toggletip mode only: click's own open/closed parity, independent of the
  // hover/focus-driven anchor. A real mouse click is always preceded by the
  // pointer hovering onto the button (that's how a mouse click works), which
  // already reveals the bubble via handlePointerEnter — so toggling based on
  // "is the bubble currently visible" would immediately re-hide what hover just
  // showed. Tracking click's own parity here (and only mutating it, and
  // reading it, from the click handler) keeps the click toggle correct
  // regardless of what hover/focus are doing concurrently.
  const pinnedRef = useRef(false)
  const bubbleId = useId()

  const position = (r: DOMRect) => {
    if (placement === 'right') {
      const fitsRight = !maxWidth || r.right + 8 + maxWidth <= window.innerWidth - 8
      return fitsRight ? tooltipPositionRight(r) : tooltipPositionBelow(r)
    }
    if (placement === 'bottom-start') return tooltipPositionBelow(r)
    if (placement === 'bottom') {
      let x = r.left + r.width / 2
      if (maxWidth) {
        x = Math.max(maxWidth / 2 + 8, Math.min(x, window.innerWidth - maxWidth / 2 - 8))
      }
      return { position: 'fixed' as const, left: x, top: r.bottom + 6, transform: 'translateX(-50%)' }
    }
    if (placement === 'top-start') {
      return { position: 'fixed' as const, left: r.left, top: r.top, transform: 'translateX(0%) translateY(calc(-100% - 6px))' }
    }
    if (placement === 'top-end') {
      return { position: 'fixed' as const, left: r.right, top: r.top, transform: 'translateX(-100%) translateY(calc(-100% - 6px))' }
    }
    // 'top' — centered above, clamped so a wide bubble can't spill off-screen or
    // (when boundaryRef is given) past that element's right edge.
    let x = r.left + r.width / 2
    if (maxWidth) {
      const rightLimit = boundaryRef?.current
        ? Math.min(window.innerWidth, boundaryRef.current.getBoundingClientRect().right)
        : window.innerWidth
      x = Math.max(maxWidth / 2 + 8, Math.min(x, rightLimit - maxWidth / 2 - 8))
    }
    return tooltipPosition({ x, y: r.top })
  }

  const bubble = anchor
    ? (
      <span
        id={toggletip ? bubbleId : undefined}
        role={toggletip ? 'tooltip' : undefined}
        aria-hidden={toggletip ? undefined : true}
        style={{
          ...position(anchor),
          ...TOOLTIP_STYLE,
          ...(maxWidth
            ? { whiteSpace: 'normal' as const, maxWidth, width: 'max-content', textAlign: 'left' as const, lineHeight: 1.4, fontWeight: 'normal' as const }
            : {}),
        }}
      >{text}</span>
    )
    : null

  const setRef = (el: HTMLElement | null) => { ref.current = el }
  const show = () => { if (ref.current) setAnchor(ref.current.getBoundingClientRect()) }
  // Hiding always resets pinnedRef too, so a later Escape/blur/pointerleave
  // can't leave click's toggle parity stale — the next click still correctly
  // reads as "currently closed" and reopens rather than no-op-closing again.
  const hide = () => { pinnedRef.current = false; setAnchor(null) }

  const handlePointerEnter = (e: ReactPointerEvent) => {
    if (e.pointerType !== 'mouse') return
    show()
  }
  const handlePointerLeave = () => hide()
  const handleFocus = () => show()
  const handleBlur = () => hide()

  const inner = <>{children}{portal && bubble ? createPortal(bubble, document.body) : bubble}</>

  if (toggletip) {
    const handleClick = () => {
      if (pinnedRef.current) {
        pinnedRef.current = false
        hide()
      } else {
        pinnedRef.current = true
        show()
      }
    }
    const handleKeyDown = (e: ReactKeyboardEvent) => {
      if (e.key === 'Escape') hide()
    }
    return (
      <button
        type="button"
        ref={setRef}
        style={{
          display: block ? 'block' : 'inline-flex',
          width: block ? '100%' : undefined,
          alignItems: 'center',
          background: 'none',
          border: 'none',
          padding: 0,
          margin: 0,
          font: 'inherit',
          color: 'inherit',
          textAlign: 'inherit',
          cursor: 'pointer',
        }}
        onPointerEnter={handlePointerEnter}
        onPointerLeave={handlePointerLeave}
        onFocus={handleFocus}
        onBlur={handleBlur}
        onClick={handleClick}
        onKeyDown={handleKeyDown}
        aria-describedby={anchor ? bubbleId : undefined}
      >
        {inner}
      </button>
    )
  }

  return block
    ? (
      <div ref={setRef} style={{ display: 'block', width: '100%' }} onPointerEnter={handlePointerEnter} onPointerLeave={handlePointerLeave} onFocus={handleFocus} onBlur={handleBlur}>
        {inner}
      </div>
    )
    : (
      <span ref={setRef} style={{ display: 'inline-flex', alignItems: 'center' }} onPointerEnter={handlePointerEnter} onPointerLeave={handlePointerLeave} onFocus={handleFocus} onBlur={handleBlur}>
        {inner}
      </span>
    )
}
