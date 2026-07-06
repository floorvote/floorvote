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
}

// A ⓘ trigger wrapping the shared HoverTooltip primitive. `align` maps onto the
// primitive's `placement` vocabulary (all variants render above the icon).
export function InfoTooltip({ text, maxWidth, align = 'right' }: InfoTooltipProps) {
  return (
    <HoverTooltip text={text} maxWidth={maxWidth} placement={ALIGN_TO_PLACEMENT[align]}>
      <span className="material-symbols-outlined" style={{ fontSize: fontSize.base, color: color.textMuted, userSelect: 'none', lineHeight: 1 }}>info</span>
    </HoverTooltip>
  )
}
