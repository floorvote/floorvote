import { color, fontSize, fontWeight } from '../../styles/tokens'
import { PinnedShadow } from './PinnedShadow'

/**
 * Sticky group-heading row for a virtualized option list (SubjectFilterDropdown,
 * FilterSheetVirtualList) — the same idiom as DateDivider (ui/DateDivider.tsx),
 * adapted for virtualized/absolutely-positioned rows instead of real in-flow
 * siblings. Carries the same lessons that file's header comment documents:
 *  - an opaque `background` (not transparent) masks option rows scrolling
 *    underneath while pinned;
 *  - padding rather than margin, so the opaque background actually covers the
 *    row (margin would leave a transparent gap above the label);
 *  - pinned 1px above its nominal position so a sub-pixel gap between the
 *    sticky row and the virtualized row above it can't let content peek
 *    through the seam;
 *  - a bottom rule for separation from the rows below, and a downward shadow
 *    while pinned (mirroring PinnedShadow's day-divider usage), so the header
 *    reads as a header and not as floating text.
 *
 * Push-out (the next group's header displacing this one) and the 1px seam
 * overlap are both applied by the caller to the *row wrapper*'s own position
 * (see getRowWrapperStyle in stickyGroupedVirtualList.ts) — sticky positioning
 * has to live on the wrapper, not in here, or the header would scroll away
 * with its (short, absolutely-positioned) containing block once it's no
 * longer the active sticky row. This component only carries the visual
 * chrome: opaque background, padding, rule, and shadow.
 */
export function StickyGroupHeader({
  label, height, stuck, pushOffset, padding = '0 12px',
}: {
  label: string
  height: number
  /** Whether this header is actually pinned right now (drives the shadow). */
  stuck: boolean
  /** Push-out amount from computeStickyPushOffset — shown here only to decide
   *  when the shadow fades (see below), not applied as positioning. */
  pushOffset: number
  padding?: string
}) {
  return (
    <div
      style={{
        height,
        boxSizing: 'border-box',
        display: 'flex',
        alignItems: 'center',
        background: color.surfaceMuted,
        borderBottom: `1px solid ${color.borderDefault}`,
        padding,
        fontSize: fontSize.xs,
        fontWeight: fontWeight.semibold,
        color: color.textMuted,
        textTransform: 'uppercase',
        letterSpacing: '0.05em',
        position: 'relative',
      }}
    >
      {label}
      {/* Shadow fades out the moment push-out begins (pushOffset > 0), same as
          DateDivider's SHADOW_PUSH_LEAD = 0 convention. */}
      <PinnedShadow visible={stuck && pushOffset === 0} fade={false} />
    </div>
  )
}
