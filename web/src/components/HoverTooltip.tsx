import { useState, useRef, type ReactNode } from 'react'
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
}

export function HoverTooltip({ text, children, placement = 'top', maxWidth, portal = false }: HoverTooltipProps) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null)
  const ref = useRef<HTMLSpanElement>(null)

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
    // 'top' — centered above, clamped so a wide bubble can't spill off-screen.
    let x = r.left + r.width / 2
    if (maxWidth) {
      x = Math.max(maxWidth / 2 + 8, Math.min(x, window.innerWidth - maxWidth / 2 - 8))
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

  return (
    <span
      ref={ref}
      style={{ display: 'inline-flex', alignItems: 'center' }}
      onPointerEnter={(e) => {
        if (e.pointerType !== 'mouse') return
        if (ref.current) setAnchor(ref.current.getBoundingClientRect())
      }}
      onPointerLeave={() => setAnchor(null)}
    >
      {children}
      {portal && bubble ? createPortal(bubble, document.body) : bubble}
    </span>
  )
}
