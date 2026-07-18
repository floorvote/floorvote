import { useState, useRef, type ReactNode, type RefObject, type PointerEvent as ReactPointerEvent } from 'react'
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
}

export function HoverTooltip({ text, children, placement = 'top', maxWidth, portal = false, block = false, boundaryRef }: HoverTooltipProps) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null)
  const ref = useRef<HTMLElement | null>(null)

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
      <span style={{
        ...position(anchor),
        ...TOOLTIP_STYLE,
        ...(maxWidth
          ? { whiteSpace: 'normal' as const, maxWidth, width: 'max-content', textAlign: 'left' as const, lineHeight: 1.4, fontWeight: 'normal' as const }
          : {}),
      }}>{text}</span>
    )
    : null

  const setRef = (el: HTMLElement | null) => { ref.current = el }
  const handlePointerEnter = (e: ReactPointerEvent) => {
    if (e.pointerType !== 'mouse') return
    if (ref.current) setAnchor(ref.current.getBoundingClientRect())
  }
  const handlePointerLeave = () => setAnchor(null)
  const inner = <>{children}{portal && bubble ? createPortal(bubble, document.body) : bubble}</>

  return block
    ? (
      <div ref={setRef} style={{ display: 'block', width: '100%' }} onPointerEnter={handlePointerEnter} onPointerLeave={handlePointerLeave}>
        {inner}
      </div>
    )
    : (
      <span ref={setRef} style={{ display: 'inline-flex', alignItems: 'center' }} onPointerEnter={handlePointerEnter} onPointerLeave={handlePointerLeave}>
        {inner}
      </span>
    )
}
