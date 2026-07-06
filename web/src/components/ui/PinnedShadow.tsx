const edgeFade = 'linear-gradient(to right, transparent, rgba(0,0,0,1) 24px, rgba(0,0,0,1) calc(100% - 24px), transparent)'

/**
 * A soft downward gradient shadow that sits just BELOW its (positioned) parent's
 * bottom edge — for pinned/sticky headers, shown only while content scrolls under.
 * Casts straight down (no shadow on the vertical edges); the horizontal mask fades
 * its left/right ends. The parent must establish a positioning context.
 *
 * @param visible  fade the shadow in (true) or out (false)
 * @param overhang px the bar extends past each side of the parent (default 0). The
 *   day dividers use 20 to reach into the page gutter; full-width headers use 0.
 * @param fade  fade the shadow's left/right ends with a horizontal mask (default
 *   true). Pass false for a constant shadow contained within the parent's width
 *   (e.g. a table or widget scroll area, where it shouldn't taper at the edges).
 */
export function PinnedShadow({ visible, overhang = 0, fade = true }: { visible: boolean; overhang?: number; fade?: boolean }) {
  const reduceMotion = typeof window !== 'undefined'
    && !!window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches
  return (
    <div
      aria-hidden="true"
      style={{
        position: 'absolute',
        top: '100%',
        left: -overhang,
        right: -overhang,
        height: 7,
        background: 'linear-gradient(to bottom, rgba(0,0,0,0.15), rgba(0,0,0,0))',
        ...(fade ? { maskImage: edgeFade, WebkitMaskImage: edgeFade } : null),
        opacity: visible ? 1 : 0,
        transition: reduceMotion ? 'none' : 'opacity 0.25s ease',
        pointerEvents: 'none',
      }}
    />
  )
}
