import { type ReactNode } from 'react'
import { color, fontSize } from '../styles/tokens'
import { HoverTooltip, type Placement } from './HoverTooltip'

type Align = 'left' | 'center' | 'right'

const ALIGN_TO_PLACEMENT: Record<Align, Placement> = {
  left: 'top-start',
  center: 'top',
  right: 'top-end',
}

interface InfoTooltipProps {
  text: ReactNode
  /** Cap the bubble width and let text wrap. Omit for the default single-line bubble. */
  maxWidth?: number
  /**
   * Horizontal anchor relative to the icon. Default 'right' — the bubble's right
   * edge sits at the icon and it extends left, which keeps icons near a right
   * edge (e.g. a card's top-right corner) on screen. 'center' for icons with
   * room on both sides, 'left' for icons near a left edge.
   */
  align?: Align
  /**
   * Accessible name for the ⓘ button. The "info" glyph is a font ligature with
   * no text name of its own, so this is what a screen reader announces (along
   * with the tooltip text via aria-describedby). Default covers the common case;
   * override when a screen reader user needs more context than "More information".
   */
  label?: string
}

// A ⓘ toggletip trigger wrapping the shared HoverTooltip primitive: reachable
// by touch (tap) and keyboard (focus + Enter/Space to toggle, Escape to
// dismiss), not just mouse hover. `align` maps onto the primitive's
// `placement` vocabulary (all variants render above the icon).
export function InfoTooltip({ text, maxWidth, align = 'right', label = 'More information' }: InfoTooltipProps) {
  return (
    <HoverTooltip toggletip ariaLabel={label} text={text} maxWidth={maxWidth} placement={ALIGN_TO_PLACEMENT[align]}>
      <span
        aria-hidden="true"
        className="material-symbols-outlined"
        style={{ fontSize: fontSize.base, color: color.textMuted, userSelect: 'none', lineHeight: 1 }}
      >info</span>
    </HoverTooltip>
  )
}
