import {
  useCallback, useEffect, useId, useLayoutEffect, useRef, useState,
  type CSSProperties, type MouseEvent, type ReactNode, type RefObject,
} from 'react'
import { flushSync } from 'react-dom'
import { color, fontSize, fontWeight } from '../styles/tokens'
import { FONT_SANS } from '../lib/textStyles'
import { usePrefersReducedMotion } from '../lib/usePrefersReducedMotion'
import { EASE } from './CollapsibleSection'

// One in-place "show more" fold for the whole app: a clipped preview that opens where it
// sits, behind one small blue link under the text. Three pieces, so each fold can pick how
// much it needs:
//
//   <Fold>        clamped text, or a rendered block clipped by height with a fade. Measures
//                 whether it is cut off and renders its own toggle. Use this when the
//                 folded content is a block of text or markup.
//   useFold()     the open state and the height animation, for folds whose content isn't a
//                 clamp (a capped list of chips, a one-line run of names). The caller works
//                 out what "folded" shows and how many items that hides.
//   <FoldToggle>  the link itself. It stops its click from reaching a parent, so a fold
//                 inside a link or a clickable row can't open the link.

/** How long the clip box takes to grow or shrink. A summary opens much farther than a
 *  collapsible section's header, so this is longer than CollapsibleSection's 160ms. */
export const FOLD_MS = 240

/** The look of every fold link: 12px blue, no chrome. Exported so a control that opens
 *  something other than an in-place fold (the month grid's "+N more" popover) can wear
 *  the same text style. */
export const FOLD_LINK_STYLE: CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 4,
  padding: 0, border: 'none', background: 'none', cursor: 'pointer',
  fontFamily: FONT_SANS, fontSize: fontSize.sm, fontWeight: fontWeight.medium, fontStyle: 'normal',
  color: color.linkBlue, whiteSpace: 'nowrap',
}

export interface FoldState {
  /** What the control reports: true once the fold has been asked to open. */
  open: boolean
  /** What to render: open, or closed but still showing the open content while the fold
   *  animates shut. Render the full content when this is true. */
  expanded: boolean
  toggle: () => void
  /** Spread onto the element whose height animates. */
  clipProps: { ref: RefObject<HTMLDivElement | null>; id: string; 'data-fold-state': 'open' | 'folded' }
}

/**
 * The open state of a fold and the height animation between its two states.
 *
 * On a toggle, the clip box's height is read, the new state is rendered, its height is read
 * again, and the box animates between the two. Folding keeps the open content in place
 * until the motion ends (`expanded` stays true), so the text doesn't jump to its folded
 * form before it starts shrinking. A second click mid-motion cancels the running animation
 * and starts the next from wherever the box has got to. With reduced motion, or where
 * Element.animate doesn't exist, the end state is applied at once.
 */
export function useFold(): FoldState {
  const reduce = usePrefersReducedMotion()
  const [open, setOpen] = useState(false)
  const [holding, setHolding] = useState(false)
  const clipRef = useRef<HTMLDivElement>(null)
  const running = useRef<Animation | null>(null)
  const id = useId()

  const stop = () => {
    running.current?.cancel()
    running.current = null
    if (clipRef.current) clipRef.current.style.overflow = ''
  }
  useEffect(() => () => running.current?.cancel(), [])

  const toggle = useCallback(() => {
    const clip = clipRef.current
    // Read before cancelling: mid-motion this is the height the box has reached.
    const from = clip ? clip.getBoundingClientRect().height : 0
    stop()
    const next = !open
    // Render the end state now, so its height can be measured.
    flushSync(() => { setOpen(next); setHolding(false) })
    if (!clip || reduce || typeof clip.animate !== 'function') return
    const to = clip.getBoundingClientRect().height
    if (Math.abs(to - from) < 1) return
    if (!next) flushSync(() => setHolding(true))
    // The box clips only while it moves, so focus rings aren't cut off at rest.
    clip.style.overflow = 'hidden'
    const animation = clip.animate([{ height: `${from}px` }, { height: `${to}px` }], { duration: FOLD_MS, easing: EASE, fill: 'forwards' })
    running.current = animation
    // Without a fill, the box would drop to its natural height at the finish, and while
    // folding that is still the full open content (`holding`) until React commits: one
    // painted frame of everything below the fold jumping. So the animation holds its end
    // height (fill forwards), the folded form is committed synchronously, and only then is
    // the fill released (cancel), by which time natural height is the end height.
    const settle = () => {
      running.current = null
      flushSync(() => setHolding(false))
      clip.style.overflow = ''
      animation.cancel()
    }
    // A cancel from outside (a hidden tab, devtools) also lets go of the held open content;
    // otherwise it would leave a folded fold stuck showing everything. Our own cancels are
    // told apart by the guard: by the time their event arrives, `running` is null or a newer
    // animation.
    const cancelled = () => {
      if (running.current !== animation) return
      running.current = null
      clip.style.overflow = ''
      setHolding(false)
    }
    animation.onfinish = () => { if (running.current === animation) settle() }
    animation.oncancel = cancelled
  }, [open, reduce])

  return {
    open,
    expanded: open || holding,
    toggle,
    clipProps: { ref: clipRef, id, 'data-fold-state': open || holding ? 'open' : 'folded' },
  }
}

/**
 * The fold link. A text fold reads "Show more" / "Show less" with a ▼ that turns over when
 * open (the same glyph the collapsible sections use). A count fold, given `count`, reads
 * "+N more" / "Show less" with no chevron: the count already says what it does, and its
 * items fill in across and then down, so there's no honest direction to point.
 */
export function FoldToggle({ open, onToggle, count, controls, style }: {
  open: boolean
  onToggle: () => void
  /** Hidden item count. Makes this a count fold. */
  count?: number
  /** Id of the clip box this opens. */
  controls?: string
  style?: CSSProperties
}) {
  const reduce = usePrefersReducedMotion()
  const isCount = count !== undefined
  const label = open ? 'Show less' : isCount ? `+${count} more` : 'Show more'
  const click = (e: MouseEvent) => {
    // The fold usually sits inside something clickable (a bill row's link, a card that
    // navigates), and opening it must not also open that.
    e.stopPropagation()
    e.preventDefault()
    onToggle()
  }
  return (
    <button
      type="button"
      onClick={click}
      // A card that opens its bill on a middle click would otherwise open it from the toggle too.
      onAuxClick={(e) => e.stopPropagation()}
      aria-expanded={open}
      aria-controls={controls}
      style={{ ...FOLD_LINK_STYLE, marginTop: 4, ...style }}
    >
      <span className="blue-link">{label}</span>
      {!isCount && (
        <span
          data-fold-chevron
          aria-hidden="true"
          style={{
            // About 7px beside the 12px label, as in the approved mockup.
            display: 'inline-block', fontSize: '0.6em', lineHeight: 1,
            transform: open ? 'rotate(180deg)' : 'rotate(0deg)',
            transition: reduce ? undefined : `transform ${FOLD_MS}ms ${EASE}`,
          }}
        >▼</span>
      )}
    </button>
  )
}

/** How a folded Fold is cut off: after N lines, or at a height with an optional bottom fade
 *  (for rendered markup, where a line clamp can't reach through nested blocks). */
export type FoldCollapse =
  | { lines: number }
  | { maxHeight: number | string; fade?: boolean }

const FADE_MASK = 'linear-gradient(to bottom, black calc(100% - 1.4em), transparent)'

/**
 * Content that folds to a few lines or a fixed height and opens in place. The toggle shows
 * only while the folded content is actually cut off, or while the fold is open. jsdom has
 * no layout, so tests stub scrollHeight and clientHeight to say whether it overflows.
 */
export function Fold({ collapsed, as: Tag = 'div', style, className, wrapperStyle, toggleStyle, children }: {
  collapsed: FoldCollapse
  /** The element holding the content (and its clamp). */
  as?: 'div' | 'p'
  /** Typography and the like for the content element. */
  style?: CSSProperties
  /** On the outer wrapper, for a stylesheet that reaches the rendered content. */
  className?: string
  /** Spacing around the whole fold belongs here: a margin on the content or the clip box
   *  would stop collapsing while the clip box clips (overflow:hidden), and the height would jump. */
  wrapperStyle?: CSSProperties
  toggleStyle?: CSSProperties
  children: ReactNode
}) {
  const fold = useFold()
  const contentRef = useRef<HTMLDivElement>(null)
  const [overflows, setOverflows] = useState(false)

  // Measured, not guessed from the text, and only while folded: open content is never cut.
  const measure = useCallback(() => {
    const el = contentRef.current
    if (el) setOverflows(el.scrollHeight > el.clientHeight + 1)
  }, [])
  // Every render: the children may have changed. A same-value setState bails out.
  useLayoutEffect(() => { if (!fold.expanded) measure() })
  useLayoutEffect(() => {
    const el = contentRef.current
    if (fold.expanded || !el) return
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    observer?.observe(el)
    window.addEventListener('resize', measure)
    return () => { observer?.disconnect(); window.removeEventListener('resize', measure) }
  }, [fold.expanded, measure])

  const fading = !fold.expanded && 'maxHeight' in collapsed && !!collapsed.fade && overflows
  const clip: CSSProperties = 'lines' in collapsed
    ? { display: '-webkit-box', WebkitLineClamp: collapsed.lines, WebkitBoxOrient: 'vertical', overflow: 'hidden' } as CSSProperties
    : {
      maxHeight: collapsed.maxHeight, overflow: 'hidden',
      ...(fading ? { WebkitMaskImage: FADE_MASK, maskImage: FADE_MASK } : {}),
    }
  const showToggle = fold.open || overflows

  return (
    <div className={className} style={wrapperStyle}>
      <div {...fold.clipProps}>
        <Tag
          ref={contentRef as RefObject<never>}
          data-fold-fade={fading ? '' : undefined}
          style={{ ...style, ...(fold.expanded ? {} : clip) }}
        >{children}</Tag>
      </div>
      {showToggle && <FoldToggle open={fold.open} onToggle={fold.toggle} controls={fold.clipProps.id} style={toggleStyle} />}
    </div>
  )
}
