import { useState } from 'react'
import type { CSSProperties, DragEvent } from 'react'
import { color } from '../styles/tokens'

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

export interface UseDragReorderOptions {
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
}

export interface DragReorder {
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
  gripProps: (i: number) => {
    draggable: boolean
    onDragStart?: (e: DragEvent) => void
    onDragEnd?: () => void
  }
  /** Spread onto item `i`'s drop target (usually the whole row, not the grip). */
  dropProps: (i: number) => DropTargetProps
  /** Spread onto the append-at-end drop zone. */
  tailDropProps: () => DropTargetProps
  /** Style for the row a drag started from. */
  sourceStyle: (i: number) => CSSProperties
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

export function useDragReorder({
  count, onReorder, disabled = false, mime = DRAG_REORDER_MIME,
}: UseDragReorderOptions): DragReorder {
  const [dragFrom, setDragFrom] = useState<number | null>(null)
  const [dragOver, setDragOver] = useState<number | null>(null)

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
        if (!acceptsSlot(Number.isNaN(from) ? null : from, slot)) return
        onReorder(from, destinationFor(from, slot))
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
      if (disabled) return { draggable: false }
      return {
        draggable: true,
        onDragStart: e => {
          e.dataTransfer.effectAllowed = 'move'
          e.dataTransfer.setData(mime, String(i))
          setDragFrom(i)
        },
        onDragEnd: () => { setDragFrom(null); setDragOver(null) },
      }
    },
    dropProps: i => { assertItem(i, 'dropProps'); return dropPropsForSlot(i) },
    tailDropProps: () => dropPropsForSlot(count),
    sourceStyle: i => ({ opacity: dragFrom === i ? DRAG_SOURCE_OPACITY : 1 }),
  }
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
