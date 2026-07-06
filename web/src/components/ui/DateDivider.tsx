import { useEffect, useRef, useState } from 'react'
import { color } from '../../styles/tokens'
import { PinnedShadow } from './PinnedShadow'
import { DateLabel } from './DateLabel'

/** px before the push-contact point at which the outgoing shadow starts fading.
 *  0 = keep the shadow until the section is fully at the push point. */
export const SHADOW_PUSH_LEAD = 0

/**
 * Decide whether a sticky divider should show its pinned shadow.
 * @param wrapper  the day-group wrapper's viewport rect ({ top, bottom })
 * @param lineY    viewport y of the sticky line (scroll-container top + sticky offset)
 * @param dividerHeight  the divider's own pixel height
 */
export function isDividerStuck(
  wrapper: { top: number; bottom: number },
  lineY: number,
  dividerHeight: number,
): boolean {
  const pinned = wrapper.top <= lineY
  const beingPushed = wrapper.bottom <= lineY + dividerHeight + SHADOW_PUSH_LEAD
  return pinned && !beingPushed
}

/**
 * Left-aligned label + a rule filling the rest of the width. Shared by Feed +
 * the calendar agenda. Sticky: pins beneath `stickyTop` px (0 on Feed, the
 * sticky-header height on the agenda) and grows a downward shadow while pinned,
 * fading out as the next day's wrapper pushes it up.
 *
 * MUST be the first child of a per-day wrapper element: that wrapper is the
 * sticky containing block (it produces the push) and its rect drives the
 * pinned-shadow decision.
 *
 * Assumes a `color.surfaceMuted` page background — the divider paints that
 * color to mask content scrolling beneath it while pinned. Both current
 * consumers (Feed, calendar agenda) render over `surfaceMuted`.
 */
export function DateDivider({ label, isToday = false, stickyTop = 0 }: {
  label: string
  isToday?: boolean
  stickyTop?: number
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [stuck, setStuck] = useState(false)

  useEffect(() => {
    const el = ref.current
    const wrapper = el?.parentElement
    const scroller = el?.closest('main')
    if (!el || !wrapper || !scroller) return

    let raf = 0
    const update = () => {
      raf = 0
      const lineY = scroller.getBoundingClientRect().top + stickyTop
      const r = wrapper.getBoundingClientRect()
      setStuck(isDividerStuck({ top: r.top, bottom: r.bottom }, lineY, el.offsetHeight))
    }
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(update) }

    update()
    scroller.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onScroll)
    return () => {
      scroller.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onScroll)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [stickyTop])

  // Pin 1px UNDER the header so a sub-pixel measurement gap can't let content
  // peek through the seam above the divider; the overlap hides under the
  // header's opaque background (which sits at a higher z-index).
  const pinTop = stickyTop > 0 ? stickyTop - 1 : 0

  return (
    <div
      ref={ref}
      style={{
        position: 'sticky',
        top: pinTop,
        zIndex: 5, // above cards/rows (auto), below the agenda sticky header (zIndex 10)
        background: color.surfaceMuted,
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        // was margin '14px 0 8px' — now padding so the surface background masks
        // content scrolling underneath while pinned. The negative horizontal
        // margin + matching padding widens the opaque background past the cards
        // so the Feed cards' side shadows don't peek at the divider's edges.
        margin: '0 -8px',
        padding: '14px 8px 8px',
      }}
    >
      <DateLabel label={label} isToday={isToday} />
      <div style={{ flex: 1, height: 1, background: color.borderDefault }} />
      {/* Pinned shadow — extends into the page gutter (overhang) and fades at the ends. */}
      <PinnedShadow visible={stuck} overhang={20} />
    </div>
  )
}
