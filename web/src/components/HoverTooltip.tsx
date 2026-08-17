import { useId, useState, useRef, type ReactNode, type RefObject, type PointerEvent as ReactPointerEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { TOOLTIP_STYLE, tooltipPosition, tooltipPositionBelow, tooltipPositionRight } from '../lib/chipStyles'

export type Placement = 'top' | 'top-start' | 'top-end' | 'bottom' | 'bottom-start' | 'right'

// One hover tooltip for all white-bubble cases. Behavior collected from the
// three components it replaces:
//  - anchor measured on hover via getBoundingClientRect (HoverTip/InfoTooltip)
//  - pointer events with a mouse-only guard so a tap can't strand the bubble
//    (FilterTooltip) — a touch fires pointerenter with no matching leave
//  - portal to document.body by default, so no ancestor can clip, mis-anchor,
//    or out-stack the bubble. This is the default rather than an opt-in because
//    the bubble is already position:fixed at viewport coordinates taken from
//    getBoundingClientRect, so portaling never changes where it is drawn — it
//    only changes which ancestor properties can interfere with it, and every
//    one of those interferes destructively:
//      * an `overflow: hidden|auto` ancestor clips the bubble;
//      * a `transform`/`filter`/`perspective`/`will-change` ancestor becomes
//        the containing block for position:fixed, silently mis-anchoring it;
//      * any ancestor stacking context (e.g. a row with position:relative and
//        a z-index) caps the bubble's effective depth, making zIndex 9000 mean
//        nothing against a sticky header — the bug this default was flipped for.
//    pointerEvents:'none' means portaling cannot change hit-testing either, so
//    portal is a strict superset of inline. `portal={false}` remains as an
//    escape hatch but should not be needed.
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
  // Escape hatch only — see the file header. Defaults to true; inline rendering
  // has no advantage over portaled and several failure modes of its own.
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
  // toggletip mode only: accessible name for the button. Required whenever
  // `children` is a bare icon glyph with no text name of its own — combined
  // with the bubble's aria-describedby, a screen reader announces "<ariaLabel>,
  // button" followed by the tooltip text on reveal.
  ariaLabel?: string
}

export function HoverTooltip({ text, children, placement = 'top', maxWidth, portal = true, block = false, boundaryRef, toggletip = false, ariaLabel }: HoverTooltipProps) {
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
  // Hiding always resets pinnedRef too, so a later Escape/blur (or an
  // unpinned pointerleave) can't leave click's toggle parity stale — the next
  // click still correctly reads as "currently closed" and reopens rather than
  // no-op-closing again.
  const hide = () => { pinnedRef.current = false; setAnchor(null) }

  // NOTE: there is deliberately no scroll handling here.
  //
  // The bubble is position:fixed at coordinates measured once when it opened, so
  // scrolling leaves it beside whatever is there now, and a browser does not
  // reliably fire pointerenter for an element that arrives under a stationary
  // cursor by scrolling. Both are known and accepted.
  //
  // Three attempts to improve on that were reverted for making things worse:
  //   1. dismiss on scroll — the dismissal fired, but a scroll also dispatches a
  //      pointermove with UNCHANGED coordinates, whose re-entry called show()
  //      again; React batched both into one render, so nothing changed on screen.
  //   2. dismiss plus a one-shot suppression of that re-entry — same outcome, the
  //      synthesised move cleared the suppression before the enter arrived.
  //   3. re-anchor to follow the element — correct in principle and idempotent
  //      with the re-entry, but it still did not fix the sidebar widgets and it
  //      regressed tooltips everywhere else.
  //
  // Anything attempted here has to be verified in a real browser first. All three
  // passed their unit tests; jsdom cannot reproduce the synthesised pointermove,
  // the batching, or the scroll containers, so green tests meant nothing.

  const handlePointerEnter = (e: ReactPointerEvent) => {
    if (e.pointerType !== 'mouse') return
    show()
  }
  // Gated on pinnedRef so a click-pinned toggletip survives the mouse moving
  // away — the toggletip hide-trigger contract is Escape/blur/second-click
  // only, not a plain pointerleave. Default mode never sets pinnedRef, so its
  // hover-leave behavior is unaffected; toggletip's plain hover (no click)
  // still closes on leave, since pinnedRef stays false until a click sets it.
  const handlePointerLeave = () => { if (!pinnedRef.current) hide() }
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
        aria-label={ariaLabel}
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
