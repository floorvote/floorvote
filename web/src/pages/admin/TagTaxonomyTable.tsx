import { Fragment, useLayoutEffect, useRef, useState } from 'react'
import { color, radius, fontSize, fontWeight } from '../../../../shared/tokens'
import {
  deriveSortDirection, moveRow, parsePastedRows, rowProblems, sortRows, withTrailingBlank,
  type SortDirection, type TaxonomyRow,
} from './taxonomyRows'

type Props = {
  rows: TaxonomyRow[]
  onChange: (rows: TaxonomyRow[]) => void
  idPrefix: string
  /**
   * Called instead of onChange when the reorder came from clicking the Tag
   * header. Config.tsx wires this to capture the pre-sort rows as the
   * taxonomy field's undo value before setting the sorted rows — a plain
   * onChange there deliberately clears that undo value on any manual edit,
   * which a sort must not do. Falls back to onChange when absent, so the
   * table stays usable on its own.
   */
  onSort?: (rows: TaxonomyRow[]) => void
}

// Shared by the header row and every body row so the two grids can never
// drift out of sync with each other. The narrow-screen override in
// mobile.css (.tag-table > div > div) targets this same grid, collapsing it
// to two tracks and dropping the grip/ordinal column.
const GRID_TEMPLATE_COLUMNS = '34px minmax(0,1fr) minmax(0,1.6fr) 34px'

/** Which editable column an interaction came from, so a move can return to it. */
type Column = 'name' | 'description'

/**
 * The tag taxonomy editor: one row per tag, name and optional description.
 *
 * Fully controlled — Config.tsx owns the array. Problems are named in the Tag
 * cell of the row that has them and never block Save; there is deliberately no
 * summary indicator anywhere else, because a count elsewhere is a second thing
 * to keep in step and it says a problem exists without saying where.
 */
export default function TagTaxonomyTable({ rows, onChange, onSort, idPrefix }: Props) {
  const displayed = withTrailingBlank(rows)
  const problems = rowProblems(displayed)
  const nameRefs = useRef<Array<HTMLInputElement | null>>([])
  const descRefs = useRef<Array<HTMLTextAreaElement | null>>([])
  const [dragFrom, setDragFrom] = useState<number | null>(null)
  const [dragOver, setDragOver] = useState<number | null>(null)
  const [announcement, setAnnouncement] = useState('')
  // Derived from `displayed` itself rather than tracked as its own state, so
  // it can never claim a direction the rows are no longer actually in — e.g.
  // after an Undo, a Reset, or rows handed in fresh from a reload. A click
  // always sorts to the opposite of whatever this reports, defaulting to
  // ascending from 'none'.
  const sortDirection = deriveSortDirection(displayed)
  // True unless every real row is equal under the name comparator — i.e.
  // unless NEITHER an ascending nor a descending sort would reorder
  // `displayed` at all (a table of only ties, like "Elections"/"elections",
  // or of only nameless rows). In that case the header must not claim a
  // sort is available: handleHeaderSort's own no-op guard already skips the
  // callback for this data (nothing here changes that), so this is purely
  // about not lying to the user or to assistive tech about what the click
  // will do.
  const canReorder = sortRows(displayed, 'asc') !== displayed || sortRows(displayed, 'desc') !== displayed

  function handleHeaderSort() {
    const next: SortDirection = sortDirection === 'asc' ? 'desc' : 'asc'
    const sorted = sortRows(displayed, next)
    if (sorted === displayed) return
    if (onSort) onSort(sorted)
    else onChange(sorted)
  }

  // Auto-grow is a function of the rendered value, not of the input event: this
  // runs on mount and on every re-render where a description changed (typed,
  // pasted programmatically, or handed in fresh from Config.tsx), so a textarea
  // is never left clipped at the default one-row height. useLayoutEffect commits
  // the height before paint, so there's no one-line flash. The onInput handler
  // below calls this same function, so there is one source of truth for the height.
  // Serialized, not joined: a plain join collapses distinct description
  // arrays to the same dependency string whenever the join character also
  // appears inside a description (e.g. ["A", "B C"] and ["A B", "C"] both
  // join-with-space to "A B C"), so a row inserted/deleted/reordered across
  // that boundary could leave a stale textarea height with no re-render to
  // fix it. JSON.stringify preserves array shape, so no two distinct
  // description arrays can collide.
  const descriptionsKey = JSON.stringify(displayed.map(r => r.description))
  useLayoutEffect(() => {
    descRefs.current.forEach(ta => { if (ta) resizeTextarea(ta) })
  }, [descriptionsKey])

  function setRow(i: number, patch: Partial<TaxonomyRow>) {
    onChange(displayed.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  }

  function insertAfter(i: number) {
    const next = [...displayed]
    next.splice(i + 1, 0, { name: '', description: '' })
    onChange(next)
    queueMicrotask(() => nameRefs.current[i + 1]?.focus())
  }

  /** Whether a row is wholly empty: no name and no description. */
  function isBlankRow(row: TaxonomyRow) {
    return !row.name.trim() && !row.description.trim()
  }

  /**
   * "+ Add tag" wants a row to type into, not necessarily a NEW row. Inserting
   * unconditionally after the last index put a blank AFTER the trailing blank,
   * and withTrailingBlank kept both — so repeated clicks piled up blanks that,
   * no longer being the last index, sprouted grips and ordinals and became
   * reorderable, contradicting the rule that the trailing blank is not a tag.
   */
  function addTag() {
    const lastIndex = displayed.length - 1
    const last = displayed[lastIndex]
    // withTrailingBlank guarantees an empty last row today, so the insert below
    // is defensive; it keeps the button correct if that ever changes.
    if (last && isBlankRow(last)) {
      nameRefs.current[lastIndex]?.focus()
      return
    }
    insertAfter(lastIndex)
  }

  function removeAt(i: number) {
    onChange(displayed.filter((_, j) => j !== i))
    queueMicrotask(() => {
      const prev = nameRefs.current[Math.max(0, i - 1)]
      prev?.focus()
      prev?.setSelectionRange(prev.value.length, prev.value.length)
    })
  }

  function reorder(from: number, to: number, focusColumn: Column = 'name') {
    // The trailing blank (last index of `displayed`) is a rendering
    // convenience, not a tag: it can never be dragged, and nothing may be
    // dropped or moved onto its slot, or a real row would end up after it
    // and the blank would get stranded mid-list on the next render.
    const lastIndex = displayed.length - 1
    if (from === lastIndex || to === lastIndex) return
    const next = moveRow(displayed, from, to)
    if (next === displayed) return
    onChange(next)
    // Count the REAL rows, not `displayed`: the trailing blank is not a tag,
    // carries no ordinal, and `to === lastIndex` is refused above, so counting
    // it would announce a position the sighted ordinals never show and that
    // nothing can ever be moved to.
    setAnnouncement(`${displayed[from].name || 'Untitled tag'} moved to position ${to + 1} of ${displayed.length - 1}`)
    // Return to the column the move was initiated from, so reordering while
    // editing descriptions does not cost a Tab after every keystroke.
    queueMicrotask(() => {
      const refs = focusColumn === 'description' ? descRefs.current : nameRefs.current
      refs[to]?.focus()
    })
  }

  function onFieldPaste(e: React.ClipboardEvent, i: number) {
    const text = e.clipboardData.getData('text')
    // A paste with no line or column separator is an ordinary one — let the
    // browser insert it at the caret rather than replacing the row.
    if (!text || (!text.includes('\n') && !text.includes('\t'))) return
    const parsed = parsePastedRows(text)
    if (!parsed.length) return
    e.preventDefault()

    const row = displayed[i]
    const blank = !row.name.trim() && !row.description.trim()
    const next = [...displayed]
    next.splice(blank ? i : i + 1, blank ? 1 : 0, ...parsed)
    onChange(next)
  }

  function onFieldKeyDown(e: React.KeyboardEvent, i: number, column: Column) {
    // Deliberately not gated on viewport width. Below the narrow breakpoint
    // mobile.css hides the drag grip for space, but Alt+Arrow is the
    // accessible route to reordering and costs no horizontal room, so it
    // keeps working at every width — hiding it there would strip the
    // accessible path while leaving nothing in its place.
    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault()
      reorder(i, e.key === 'ArrowUp' ? i - 1 : i + 1, column)
      return
    }
    const row = displayed[i]
    const empty = isBlankRow(row)
    if (e.key === 'Enter') {
      e.preventDefault()
      // Mirrors the "+ Add tag" fix above, reached by keyboard instead: Return
      // in a row that is already wholly empty must not insert another blank
      // (from ['Elections'], focusing the trailing blank and pressing Return
      // twice would otherwise yield ['Elections','','','']) — indices that are
      // no longer last would sprout grips and ordinals and become reorderable,
      // the same harm the button fix addressed. Land in a further empty row
      // if one exists; otherwise do nothing.
      if (empty) {
        const target = displayed.findIndex((r, j) => j > i && isBlankRow(r))
        if (target !== -1) nameRefs.current[target]?.focus()
        return
      }
      insertAfter(i)
      return
    }
    if (e.key === 'Backspace' && empty && displayed.length > 1) {
      e.preventDefault()
      removeAt(i)
    }
  }

  return (
    <div>
      <div className="tag-table" style={{ border: `1px solid ${color.borderStrong}`, borderRadius: radius.md, overflow: 'hidden' }}>
        <div className="tag-table-row" style={{ display: 'grid', gridTemplateColumns: GRID_TEMPLATE_COLUMNS, background: color.surfaceMuted, borderBottom: `1px solid ${color.borderStrong}` }}>
          {/* Shares the grip cell's class hook so the narrow-width rule removes
              this placeholder from grid placement too — otherwise it would keep
              claiming column 1 of row 1 and push the header into a broken
              three-row stack instead of matching the body rows' two-row shape. */}
          <span className="tag-table-reorder" style={headStyle} />
          {/* aria-sort deliberately isn't used here: this grid is div/span
              throughout with no table/row/columnheader semantics, so a
              `role="columnheader"` (the only role aria-sort is supported on)
              would need adding just to carry it — a bigger change to how the
              whole editor is navigated than this header deserves. Instead the
              button's own accessible name carries both the current state and
              what the next click will do, so nothing here goes silent for
              assistive tech. */}
          <span style={headStyle}>
            <button
              type="button"
              onClick={handleHeaderSort}
              // Not the native `disabled` attribute: that would drop the
              // button from the tab order and stop clicks from reaching
              // handleHeaderSort at all, when the reason nothing happens is
              // already enforced there (sortRows returns the same reference
              // for this data in both directions, so the no-op guard skips
              // the callback regardless). aria-disabled reports the state to
              // assistive tech without changing focusability or behaviour.
              aria-disabled={canReorder ? undefined : true}
              style={{ ...sortHeaderBtnStyle, cursor: canReorder ? 'pointer' : 'default' }}
            >
              Tag
              {/* Kept as real content inside the button (not an aria-label,
                  which would replace "Tag" and drop it from the accessible
                  name entirely — a WCAG 2.5.3 Label in Name failure for
                  anyone using voice control to say "click Tag"). Visually
                  hidden with the same clip-rect pattern the live region below
                  already uses. */}
              <span style={srOnlyStyle}>
                {!canReorder
                  ? ', rows cannot be reordered by name.'
                  : sortDirection === 'none'
                    ? ', unsorted. Click to sort A to Z.'
                    : sortDirection === 'asc'
                      ? ', sorted A to Z. Click to sort Z to A.'
                      : ', sorted Z to A. Click to sort A to Z.'}
              </span>
              <span aria-hidden="true" style={{ marginLeft: 4 }}>
                {sortDirection === 'none' ? '↕' : sortDirection === 'asc' ? '▲' : '▼'}
              </span>
            </button>
          </span>
          <span style={{ ...headStyle, borderLeft: `1px solid ${color.borderDefault}` }}>Description (optional)</span>
          <span style={headStyle} />
        </div>

        {displayed.map((row, i) => {
          const problem = problems[i]
          const msgId = `${idPrefix}-tag-problem-${i}`
          const isTrailingBlank = i === displayed.length - 1
          // Drop-indicator line shown immediately before this row while
          // dragging over it, matching Config.tsx's custom-fields list and
          // BillList/ViewSwitcher's saved-views reorder — the two other
          // reorderable lists in this codebase. The `dragFrom !== i - 1`
          // clause (alongside `dragFrom !== i`) suppresses a pointless line
          // at the drag source, where a drop would be a no-op. This applies
          // uniformly to the trailing blank (i === displayed.length - 1) too,
          // which is deliberately a valid hover/drop target below even
          // though it can never be a drag source.
          const showIndicator = dragOver === i && dragFrom !== null && dragFrom !== i && dragFrom !== i - 1
          return (
            <Fragment key={i}>
              {showIndicator && (
                <div className="tag-table-drop-indicator" style={{ height: 2, background: color.accentBlue, margin: '0 12px' }} />
              )}
              <div
                className="tag-table-row"
                style={{
                  display: 'grid',
                  gridTemplateColumns: GRID_TEMPLATE_COLUMNS,
                  borderTop: i === 0 ? undefined : `1px solid ${color.borderNeutralFaint}`,
                  background: problem ? color.bgDangerSoft : undefined,
                  opacity: dragFrom === i ? 0.4 : 1,
                }}
                // The drop target is the WHOLE row, not the 34px grip: the grip
                // is only ~10% of the row's width, and without a dragover
                // preventDefault the browser shows "no drop allowed" over the
                // tag input, the description, and the delete cell — i.e. over
                // almost everywhere someone actually releases the pointer.
                // `draggable` stays on the grip, so the grip remains the only
                // thing that can START a drag. This now includes the trailing
                // blank as a drop target (the tail drop zone below moves the
                // dragged row to the last real position), but never as a
                // source — it renders no grip at all.
                //
                // Both handlers bail out early when dragFrom is null — i.e. this
                // drag did not originate from the reorder grip. Without that
                // check, preventDefault ran (and onDrop did nothing) for ANY
                // drag over a real row, including a user dragging selected text
                // from elsewhere on the page toward a description textarea —
                // silently swallowing the browser's native "insert at caret"
                // drop. A reorder drag always sets dragFrom first (onDragStart
                // below), so this leaves reordering untouched.
                onDragEnd={() => { setDragFrom(null); setDragOver(null) }}
                onDragOver={e => {
                  if (dragFrom === null) return
                  e.preventDefault()
                  e.dataTransfer.dropEffect = 'move'
                  setDragOver(i)
                }}
                onDrop={e => {
                  if (dragFrom === null) return
                  e.preventDefault()
                  // Read the source index back from dataTransfer rather than
                  // trusting state alone, matching both existing
                  // implementations of this pattern.
                  const fromIdx = parseInt(e.dataTransfer.getData('text/plain'), 10)
                  setDragFrom(null)
                  setDragOver(null)
                  if (Number.isNaN(fromIdx)) return
                  // Insert-before-i semantics everywhere except the trailing
                  // blank: dropping on it is the tail drop zone, since
                  // insert-before cannot otherwise reach the final position.
                  // It moves the dragged row to the LAST REAL position —
                  // reorder() itself refuses `to === lastIndex` (the blank's
                  // own slot), so the target is one before it.
                  reorder(fromIdx, isTrailingBlank ? displayed.length - 2 : i)
                }}
              >
                {isTrailingBlank ? (
                  // The trailing blank is not a tag: no grip, not draggable —
                  // an affordance that does nothing is worse than no
                  // affordance. It still gets the grip's class hook (with no
                  // grip inside it) purely so the narrow-width rule removes
                  // it from grid placement the same way it removes the real
                  // grip cell — otherwise this placeholder alone would keep
                  // claiming column 1 of row 1 and break the two-row stack
                  // for the "add a tag" row.
                  <div className="tag-table-reorder" />
                ) : (
                  <div
                    className="tag-table-reorder"
                    style={{ display: 'flex', alignItems: 'flex-start', padding: '9px 4px 0 8px', gap: 4 }}
                    draggable
                    onDragStart={e => {
                      e.dataTransfer.effectAllowed = 'move'
                      e.dataTransfer.setData('text/plain', String(i))
                      setDragFrom(i)
                    }}
                  >
                    <span aria-hidden="true" style={{ cursor: 'grab', color: color.textMuted, fontSize: fontSize.sm, userSelect: 'none' }}>⠿</span>
                    <span aria-hidden="true" style={{ fontSize: fontSize.xs, color: color.textMuted, fontVariantNumeric: 'tabular-nums' }}>{i + 1}</span>
                  </div>
                )}

                <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                  <input
                    ref={el => { nameRefs.current[i] = el }}
                    type="text"
                    value={row.name}
                    aria-label={`Tag name, row ${i + 1}`}
                    aria-invalid={problem ? true : undefined}
                    aria-describedby={problem ? msgId : undefined}
                    placeholder={isTrailingBlank ? 'Add a tag…' : undefined}
                    onChange={e => setRow(i, { name: e.target.value })}
                    onKeyDown={e => onFieldKeyDown(e, i, 'name')}
                    onPaste={e => onFieldPaste(e, i)}
                    style={{ ...fieldStyle, fontWeight: fontWeight.medium, color: problem ? color.textDanger : color.textPrimary }}
                  />
                  {problem && <div id={msgId} style={msgStyle}>{problem}</div>}
                </div>

                <div style={{ display: 'flex', minWidth: 0, borderLeft: `1px solid ${color.borderNeutralFaint}` }}>
                  <textarea
                    ref={el => { descRefs.current[i] = el }}
                    rows={1}
                    value={row.description}
                    aria-label={`Description, row ${i + 1}`}
                    placeholder="Optional context for the AI"
                    onChange={e => setRow(i, { description: e.target.value })}
                    onKeyDown={e => onFieldKeyDown(e, i, 'description')}
                    onPaste={e => onFieldPaste(e, i)}
                    onInput={e => resizeTextarea(e.currentTarget)}
                    style={{ ...fieldStyle, color: color.textSecondary, resize: 'none', overflow: 'hidden' }}
                  />
                </div>

                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '5px 4px' }}>
                  <button
                    type="button"
                    aria-label={`Delete row ${i + 1}`}
                    onClick={() => removeAt(i)}
                    style={delStyle}
                  >
                    ×
                  </button>
                </div>
              </div>
            </Fragment>
          )
        })}
      </div>

      <div style={{ marginTop: 9 }}>
        <button
          type="button"
          onClick={addTag}
          style={addStyle}
        >
          + Add tag
        </button>
      </div>

      <div role="status" aria-live="polite" style={{
        position: 'absolute', width: 1, height: 1, overflow: 'hidden',
        clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap',
      }}>{announcement}</div>
    </div>
  )
}

function resizeTextarea(ta: HTMLTextAreaElement) {
  ta.style.height = 'auto'
  ta.style.height = `${Math.max(ta.scrollHeight, 34)}px`
}

// Same clip-rect incantation as the aria-live region below, so the two
// visually-hidden techniques in this component don't drift apart.
const srOnlyStyle: React.CSSProperties = {
  position: 'absolute', width: 1, height: 1, overflow: 'hidden',
  clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap',
}

const sortHeaderBtnStyle: React.CSSProperties = {
  font: 'inherit', fontSize: 'inherit', fontWeight: 'inherit', letterSpacing: 'inherit',
  textTransform: 'inherit', color: 'inherit', background: 'none', border: 'none',
  padding: 0, cursor: 'pointer', display: 'inline-flex', alignItems: 'center',
}

const headStyle: React.CSSProperties = {
  padding: '7px 10px', fontSize: fontSize.xs, fontWeight: fontWeight.semibold,
  letterSpacing: '0.05em', textTransform: 'uppercase', color: color.textMuted,
}

const fieldStyle: React.CSSProperties = {
  width: '100%', border: 'none', background: 'none', font: 'inherit',
  fontSize: fontSize.sm, padding: '8px 10px', margin: 0, outline: 'none', lineHeight: 1.5,
}

const msgStyle: React.CSSProperties = {
  fontSize: fontSize.xs, fontWeight: fontWeight.medium,
  color: color.textDanger, padding: '0 10px 6px',
}

const delStyle: React.CSSProperties = {
  border: 'none', background: 'none', cursor: 'pointer', color: color.textMuted,
  fontSize: fontSize.lg, lineHeight: 1, width: 24, height: 24, borderRadius: radius.sm,
}

const addStyle: React.CSSProperties = {
  font: 'inherit', fontSize: fontSize.sm, fontWeight: fontWeight.medium, color: color.textSlate,
  background: color.white, border: `1px solid ${color.borderStrong}`,
  borderRadius: radius.md, padding: '4px 10px', cursor: 'pointer',
}
