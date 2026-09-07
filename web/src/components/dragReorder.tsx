import { useRef, useState } from 'react'
import type { CSSProperties, DragEvent, KeyboardEvent } from 'react'
import { color } from '../styles/tokens'
import { SR_ONLY } from '../lib/textStyles'

// Shared drag-to-reorder interaction for the three reorderable lists in this
// app — the tag taxonomy table (TagTaxonomyTable.tsx), custom fields
// (admin/Config.tsx) and saved views (BillList/ViewSwitcher.tsx). Extracted
// alongside stickyGroupedVirtualList.ts for the same reason: three hand-rolled
// copies had drifted, and two of them carried the same two bugs.
//
// The primitive owns interaction and geometry ONLY. Persistence stays at the
// call site, because it genuinely differs per site: the tag table is local
// until the page's Save, custom fields PUT fire-and-forget on drop, saved views
// are optimistic-with-revert.
//
// Two bugs are made unrepresentable rather than merely fixed:
//
//  1. The off-by-one on downward drags. Every site draws the line ABOVE the
//     hovered row ("insert before row i"), but a move is a splice-out followed
//     by a splice-in: removing the source first shifts every later row up one,
//     so targeting `i` lands the row AFTER row i. The adjustment lives in
//     `destinationFor` below and NOWHERE else — `onReorder` is handed a `to`
//     that is already correct, so the call site only performs the move and has
//     no `to` of its own to get wrong.
//
//  2. A drop the indicator refused still reordering. The indicator and the
//     drop are decided by the same function, `acceptsSlot`. There is no second
//     guard to forget: if the line is not drawn for a slot, a drop on that slot
//     does nothing.
//
// Keyboard reordering lives here for the same reason. Drag-and-drop is
// inaccessible on its own, so every one of the three lists needs it, and an
// announcement or a bounds check is exactly the sort of thing three copies
// would drift on — the tag table's own copy already miscounted its total. A
// keyboard move is the SAME slot arithmetic as a drop, so it goes through the
// same `acceptsSlot` / `destinationFor` pair rather than growing a second code
// path with its own off-by-one and its own idea of the ends of the list.

// A custom MIME type, not 'text/plain': the payload is just a row index, and
// 'text/plain' makes that digit a legitimate native drop target for any
// textarea/input on the page. Someone who grabs a grip and releases over, say,
// a description field or the Config page's text areas would get the raw digit
// inserted at the caret by the browser's own text-drop handling. No native
// target accepts this type, so a reorder drag that lands somewhere other than
// a registered drop slot silently does nothing instead of leaking a digit.
export const DRAG_REORDER_MIME = 'application/x-floorvote-reorder'

/** The opacity applied to the row a drag started from, for all three sites. */
export const DRAG_SOURCE_OPACITY = 0.4

/**
 * The shortcut, spelled out for assistive tech. A keyboard user cannot see a
 * grip, so the grip's accessible name has to say what it does; this is the
 * half that is the same at every site.
 */
export const REORDER_KEY_HINT = 'Press Alt with the up or down arrow keys.'

export interface UseDragReorderOptions<C = unknown> {
  /**
   * How many REORDERABLE items the list has. Slot indices run 0..count-1 for
   * the before-row positions, and `count` itself is the append-at-end slot
   * (`tailDropProps` / `canDropAtEnd`), which insert-before semantics cannot
   * otherwise reach. Anything the list renders that is not a reorderable item
   * — the tag table's trailing blank, say — is not counted.
   */
  count: number
  /**
   * Perform the move. `to` is ALREADY adjusted for the splice-out shift, so
   * the implementation is exactly a remove-then-insert at `to` with no further
   * arithmetic. Only ever called for a from/to pair the indicator accepted, so
   * it needs no no-op guard of its own.
   */
  onReorder: (from: number, to: number) => void
  /** Turns the whole interaction off: no grip, no drop handlers, no indicator. */
  disabled?: boolean
  /** Override the drag payload type. Defaults to DRAG_REORDER_MIME. */
  mime?: string
  /**
   * What names item `i` — used in the announcement and in the grip's
   * accessible name. Only the call site knows what names a row, so only the
   * label is its business: the sentence around it, and the `of N` total, are
   * the primitive's. Defaults to a positional "Item n" so a list that has not
   * supplied one still announces something rather than `undefined`.
   */
  label?: (i: number) => string
  /**
   * Where focus goes after a move THAT MOVES FOCUS, if not the moved item's
   * own grip. Return true to say "handled, leave focus alone". The tag table
   * uses this to return to the column the move came from — it can be initiated
   * from the name input or the description textarea, and landing back on the
   * grip would cost a Tab after every move.
   *
   * `context` is whatever the call site passed to `moveByKey`; a move started
   * from the grip itself passes none, and so does a pointer drop released with
   * focus on the grip (the only drop that moves focus at all).
   */
  focusAfterMove?: (to: number, context: C | undefined) => boolean | void
  /**
   * Whether the grip is a Tab stop. True by default: at custom fields and
   * saved views the grip is the only keyboard route to reordering, so it has
   * to be reachable by Tab or it may as well not exist.
   *
   * The tag table opts out: every row there is already two tab stops (name and
   * description) which BOTH carry Alt+Arrow, so a third stop per row would
   * inflate the cost of tabbing through a taxonomy without adding a capability
   * — and mobile.css hides the grip outright at narrow widths. The grip stays
   * programmatically focusable and keeps its accessible name either way.
   */
  gripTabStop?: boolean
}

export interface DragReorder<C = unknown> {
  /** Index the current drag started from, or null when no reorder is running. */
  dragFrom: number | null
  /**
   * THE predicate, for the before-row slots. True only while a reorder drag is
   * in progress, the slot is not the source's own position, and the slot is not
   * the position immediately after the source (both of which are no-ops).
   * Decides the drop; `indicatorBefore` is this same predicate plus "and the
   * pointer is here", so the line and the drop can never disagree.
   *
   * Gates a drop target, not the indicator: it does not know where the pointer
   * currently is, so using it to decide where to draw the line would draw one
   * at every acceptable slot simultaneously. For the indicator use
   * `indicatorBefore`, which additionally requires the pointer to be over that
   * slot.
   */
  canDropBefore: (i: number) => boolean
  /** Whether to draw the line immediately before item `i`. */
  indicatorBefore: (i: number) => boolean
  /** `canDropBefore` for the append-at-end slot. */
  canDropAtEnd: () => boolean
  /** `indicatorBefore` for the append-at-end slot. */
  indicatorAtEnd: () => boolean
  /** Spread onto the grip — the ONLY thing that may start a drag. */
  gripProps: (i: number) => GripProps
  /**
   * Handle a key press on something that stands for item `i` — the grip (via
   * `gripProps`, already wired) or any other control the site wants to make a
   * reorder target, such as the tag table's name and description fields.
   *
   * Returns true when the press was a reorder shortcut and has been consumed
   * (preventDefault included), so a call site with its own key handling can
   * bail out; false when the press was nothing to do with reordering.
   *
   * A press at the end of the list — up from the first item, down from the
   * last — is still consumed, but moves nothing and announces nothing.
   */
  moveByKey: (e: KeyboardEvent, i: number, context?: C) => boolean
  /**
   * The live-region text: `"{label} moved to position {n} of {total}"`, or ''
   * before the first move. Render it with <ReorderLiveRegion />. `total` is
   * derived from `count` and never passed in by the call site — a site
   * counting its own rows is how the tag table came to announce a total that
   * included its trailing blank.
   */
  announcement: string
  /**
   * Overwrite the live-region text. For the one thing the primitive cannot
   * know: whether the call site's own persistence accepted the move. Saved
   * views is optimistic-with-revert, and a reverted move that still announced
   * "moved to position 2 of 3" tells the user the opposite of what happened.
   * Pass '' to fall silent.
   */
  announce: (text: string) => void
  /** Spread onto item `i`'s drop target (usually the whole row, not the grip). */
  dropProps: (i: number) => DropTargetProps
  /** Spread onto the append-at-end drop zone. */
  tailDropProps: () => DropTargetProps
  /** Style for the row a drag started from. */
  sourceStyle: (i: number) => CSSProperties
}

/**
 * What a grip needs to be both a drag source and a keyboard control. When the
 * interaction is disabled this is `{ draggable: false }` and nothing else: an
 * inert grip must not be a Tab stop, must not claim to be a button, and above
 * all must not announce a shortcut it does not have.
 */
export type GripProps = {
  draggable: boolean
  onDragStart?: (e: DragEvent) => void
  onDragEnd?: () => void
  ref?: (el: HTMLElement | null) => void
  tabIndex?: number
  role?: 'button'
  'aria-label'?: string
  onKeyDown?: (e: KeyboardEvent) => void
}

type DropTargetProps = {
  onDragOver?: (e: DragEvent) => void
  onDrop?: (e: DragEvent) => void
  onDragEnd?: () => void
}

/**
 * The destination index for dropping the item at `from` into slot `slot`,
 * accounting for the source being spliced out first.
 *
 * Exported for the primitive's own tests. Call sites never need it — the hook
 * hands `onReorder` an already-adjusted `to`, which is the whole point.
 */
export function destinationFor(from: number, slot: number): number {
  // A downward drag (from < slot) removes the source from below the target
  // first, shifting the target — and everything between — up by one, so
  // landing BEFORE the target's original position means slot - 1 in the
  // post-removal array. An upward drag has no shift below the target.
  //
  // The append-at-end slot (slot === count) needs no special case: `from` is
  // always less than it, so this yields count - 1, the last position.
  return from < slot ? slot - 1 : slot
}

export function useDragReorder<C = unknown>({
  count, onReorder, disabled = false, mime = DRAG_REORDER_MIME,
  label, focusAfterMove, gripTabStop = true,
}: UseDragReorderOptions<C>): DragReorder<C> {
  const [dragFrom, setDragFrom] = useState<number | null>(null)
  const [dragOver, setDragOver] = useState<number | null>(null)
  const [announcement, setAnnouncement] = useState('')
  // Grips by item index, so a keyboard move can put focus on the item it just
  // moved. Without that the next press acts on whatever row has drifted under
  // the old focus, which is a reorder nobody asked for.
  const gripRefs = useRef<Array<HTMLElement | null>>([])

  // Slot indices run 0..count: 0..count-1 are "before item i", and `count` is
  // the append-at-end slot, reachable ONLY through tailDropProps/canDropAtEnd.
  // Every item-indexed accessor asserts 0..count-1, so a call site that walks
  // one row too far (the tag table's trailing blank, say) or mistakes the tail
  // for an ordinary row throws instead of silently reordering by one.
  function assertItem(i: number, what: string) {
    if (!Number.isInteger(i) || i < 0 || i >= count) {
      throw new Error(`useDragReorder: ${what} called with item index ${i}, outside 0..${count - 1}`)
    }
  }

  /**
   * The single predicate. `from` is a parameter rather than read from state so
   * that the drop handler — which reads the source index back out of
   * dataTransfer rather than trusting state alone — asks exactly the same
   * question the indicator asked.
   */
  function acceptsSlot(from: number | null, slot: number): boolean {
    if (disabled) return false
    if (from === null || !Number.isInteger(from) || from < 0 || from >= count) return false
    if (slot < 0 || slot > count) return false
    // Both no-op positions: the source's own slot, and the slot immediately
    // after it (dropping there would put the row back where it started).
    return from !== slot && from !== slot - 1
  }

  /**
   * The one place a move happens, whether it came from a drop or from a key
   * press. Both ask `acceptsSlot` the same question and take the destination
   * from `destinationFor`, so the two routes cannot land in different places
   * or disagree about where the list ends.
   *
   * `total` in the announcement is `count` — the number of REORDERABLE items,
   * which is the primitive's to know and not the call site's to pass. The tag
   * table's trailing blank is not a tag, is not counted, and so cannot be
   * announced as a position nothing can reach.
   */
  function commitMove(from: number, slot: number, focus: null | { context: C | undefined }): boolean {
    if (!acceptsSlot(from, slot)) return false
    const to = destinationFor(from, slot)
    onReorder(from, to)
    setAnnouncement(`${label ? label(from) : `Item ${from + 1}`} moved to position ${to + 1} of ${count}`)
    if (focus) {
      // After the re-render, so the grip refs point at the moved item's new
      // position rather than the pre-move one.
      queueMicrotask(() => {
        if (focusAfterMove?.(to, focus.context) === true) return
        gripRefs.current[to]?.focus()
      })
    }
    return true
  }

  function moveByKey(e: KeyboardEvent, i: number, context?: C): boolean {
    if (disabled) return false
    if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return false
    // Alt is required because plain arrows move the caret inside the tag
    // table's text fields, where this handler also lives.
    //
    // Consumed even when the move is refused: at the ends of the list the
    // shortcut is still the shortcut, and letting Alt+Arrow through there
    // would jump the caret only on the first and last rows.
    e.preventDefault()
    // The same slots a drag would target. Down is i + 2, not i + 1: slot i + 1
    // is the "immediately after the source" no-op, so moving down one place
    // means landing before the item AFTER the next one — which destinationFor
    // then walks back by one for the splice-out. Deliberately no separate
    // arithmetic: the ends of the list fall out of acceptsSlot (slot < 0 above
    // the first item, slot > count below the last), which is also what stops
    // the tag table's trailing blank being a keyboard destination.
    commitMove(i, e.key === 'ArrowUp' ? i - 1 : i + 2, { context })
    return true
  }

  function dropPropsForSlot(slot: number): DropTargetProps {
    if (disabled) return {}
    return {
      // Cancelling dragover is what tells the browser a drop is allowed here.
      // It is deliberately NOT gated on acceptsSlot: without it the browser
      // paints "no drop allowed" while the pointer crosses the source row and
      // the row just after it, which reads as the whole list refusing the drag.
      // The drop below is what acceptsSlot gates.
      //
      // Both handlers bail out when no reorder is in progress, so an ordinary
      // drag — selected text heading for a textarea, say — falls through to the
      // browser's own "insert at caret" instead of being silently swallowed.
      onDragOver: e => {
        if (dragFrom === null) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        setDragOver(slot)
      },
      onDrop: e => {
        if (dragFrom === null) return
        e.preventDefault()
        // Re-derived from dataTransfer rather than trusting `dragFrom` state:
        // if the two ever disagree, acceptsSlot below fails closed — a mismatch
        // refuses a drop the indicator promised, and never accepts one it
        // refused. Do not collapse this back to a single source of truth.
        const from = parseInt(e.dataTransfer.getData(mime), 10)
        setDragFrom(null)
        setDragOver(null)
        // A pointer drop moves focus ONLY when focus is already inside the
        // interaction — i.e. on the source's own grip, where the mousedown
        // that began the drag put it, grips being click-focusable now that
        // they carry a tabIndex (`-1` is enough for that).
        //
        // Leaving it there would be the same stale-identity hazard the
        // keyboard path guards against WHEREVER rows are keyed by index, as
        // the tag table's are: the grip DOM node at the SOURCE index belongs
        // to a DIFFERENT item after the move (React reuses the DOM node for
        // whatever now sits at that index), so the next Alt+Arrow would move
        // that item and undo the drop. Following the moved item instead keeps
        // "focus is on the thing I just moved" true by whichever route the
        // move arrived. Where a list keys its rows by identity instead — as
        // custom fields and saved views do — React moves the actual DOM node
        // with the item, so the grip at "the source index" is already the
        // moved item and this branch is a harmless no-op there, not dead code
        // to delete.
        //
        // When focus is elsewhere (a drop released while the caret sits in
        // some field, or a synthetic drag) it stays there: yanking focus
        // across the page on drop is a jolt, and nothing is stale there.
        const focusWasOnSourceGrip = !Number.isNaN(from)
          && gripRefs.current[from] != null
          && document.activeElement === gripRefs.current[from]
        if (!Number.isNaN(from)) commitMove(from, slot, focusWasOnSourceGrip ? { context: undefined } : null)
      },
      // dragend fires on the source element and bubbles, so the grip's own
      // handler normally suffices — but a test (or a call site) may fire it on
      // the row instead, and resetting twice is harmless.
      onDragEnd: () => { setDragFrom(null); setDragOver(null) },
    }
  }

  return {
    dragFrom,
    canDropBefore: i => { assertItem(i, 'canDropBefore'); return acceptsSlot(dragFrom, i) },
    indicatorBefore: i => { assertItem(i, 'indicatorBefore'); return dragOver === i && acceptsSlot(dragFrom, i) },
    canDropAtEnd: () => acceptsSlot(dragFrom, count),
    indicatorAtEnd: () => dragOver === count && acceptsSlot(dragFrom, count),
    gripProps: i => {
      assertItem(i, 'gripProps')
      // Nothing but `draggable: false` when disabled: an inert grip that is
      // still a Tab stop is a control that swallows a Tab and does nothing,
      // and an aria-label promising Alt+Arrow would be a promise the list
      // cannot keep.
      if (disabled) return { draggable: false }
      return {
        draggable: true,
        onDragStart: e => {
          e.dataTransfer.effectAllowed = 'move'
          e.dataTransfer.setData(mime, String(i))
          setDragFrom(i)
        },
        onDragEnd: () => { setDragFrom(null); setDragOver(null) },
        ref: (el: HTMLElement | null) => { gripRefs.current[i] = el },
        tabIndex: gripTabStop ? 0 : -1,
        role: 'button',
        // Names the item and the shortcut, because a grip is invisible to a
        // keyboard user and "reorder" alone does not say how.
        'aria-label': `Reorder ${label ? label(i) : `item ${i + 1}`}. ${REORDER_KEY_HINT}`,
        onKeyDown: e => { moveByKey(e, i) },
      }
    },
    moveByKey,
    announcement,
    announce: setAnnouncement,
    dropProps: i => { assertItem(i, 'dropProps'); return dropPropsForSlot(i) },
    tailDropProps: () => dropPropsForSlot(count),
    sourceStyle: i => ({ opacity: dragFrom === i ? DRAG_SOURCE_OPACITY : 1 }),
  }
}

/**
 * The polite live region that speaks `dnd.announcement`. Exported so no site
 * hand-rolls the role/aria-live/SR_ONLY trio — a hand-rolled clip-rect copy
 * that had drifted from the shared SR_ONLY was a real bug here.
 *
 * It renders absolutely positioned (that is what SR_ONLY is), so it belongs
 * inside an element with `position: relative`, or it resolves its offsets
 * against some distant ancestor.
 */
export function ReorderLiveRegion({ announcement }: { announcement: string }) {
  return <div role="status" aria-live="polite" style={SR_ONLY}>{announcement}</div>
}

/**
 * The 2px insert-before line. Rendered by the call site (only it knows where in
 * its own DOM the line belongs), but the geometry lives here so the three lists
 * cannot drift apart again.
 *
 * `className` exists for mobile.css's `.tag-table` scoping, which needs to tell
 * a drop indicator apart from the rows it sits between.
 */
export function DropIndicator(
  { className, lineColor = color.accentBlue }: { className?: string; lineColor?: string },
) {
  return <div className={className} style={{ height: 2, background: lineColor, margin: '0 12px' }} />
}
