import { Fragment, useLayoutEffect, useRef } from 'react'
import { color, radius, fontSize, fontWeight } from '../../../../shared/tokens'
import { DropIndicator, REORDER_KEY_HINT, ReorderLiveRegion, useDragReorder } from '../../components/dragReorder'
import { SR_ONLY } from '../../lib/textStyles'
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
// mobile.css (.tag-table .tag-table-row) targets this same grid, collapsing
// it to two tracks and dropping the grip/ordinal column.
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
  // Referenced by every row's name input and description textarea — the
  // focusable things in a row — because the grip that would otherwise carry
  // the shortcut is deliberately not a Tab stop here.
  const hintId = `${idPrefix}-reorder-hint`
  const displayed = withTrailingBlank(rows)
  const problems = rowProblems(displayed)
  const nameRefs = useRef<Array<HTMLInputElement | null>>([])
  const descRefs = useRef<Array<HTMLTextAreaElement | null>>([])
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

  function removeAt(i: number) {
    onChange(displayed.filter((_, j) => j !== i))
    queueMicrotask(() => {
      const prev = nameRefs.current[Math.max(0, i - 1)]
      prev?.focus()
      prev?.setSelectionRange(prev.value.length, prev.value.length)
    })
  }

  // Drag- and keyboard-reorder, shared with custom fields (Config.tsx) and
  // saved views (BillList/ViewSwitcher.tsx) — see components/dragReorder.tsx.
  // `count` is the number of REAL rows: the trailing blank (the last index of
  // `displayed`) is a rendering convenience, not a tag, so it is never a drag
  // source, never a keyboard target, and never gets an item index. It serves
  // instead as the primitive's append-at-end zone, which is exactly what
  // dropping on it has always meant ("move to the last real position") — and
  // because `count` excludes it, it is also excluded from the announced total
  // and unreachable as a keyboard destination, with no guard of its own here.
  //
  // `to` arrives already adjusted for the splice-out shift, so onReorder moves
  // the row and does no arithmetic. The announcement and the Alt+Arrow binding
  // now live in the primitive too; what stays here is the two things only this
  // table knows — what names a row, and which column a move came from.
  const dnd = useDragReorder<Column>({
    count: displayed.length - 1,
    onReorder: (from, to) => onChange(moveRow(displayed, from, to)),
    label: i => displayed[i].name || 'Untitled tag',
    // Return to the column the move was initiated from, so reordering while
    // editing descriptions does not cost a Tab after every keystroke. A move
    // started from the grip has no column and falls through to the primitive's
    // default of focusing the moved row's own grip.
    focusAfterMove: (to, column) => {
      if (!column) return false
      const refs = column === 'description' ? descRefs.current : nameRefs.current
      refs[to]?.focus()
      return true
    },
    // Every row here is already two tab stops — the name input and the
    // description textarea — and both carry Alt+Arrow, so a third stop per row
    // would double the cost of tabbing through a taxonomy without adding
    // anything reachable. (mobile.css hides the grip entirely at narrow widths
    // for the same reason of space; Alt+Arrow keeps working at every width.)
    // The grip keeps its accessible name and stays focusable programmatically,
    // so a keyboard move initiated from it still lands on it.
    gripTabStop: false,
  })

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
    // Alt+Arrow reorders from inside the fields as well as from the grip —
    // convenient while typing, and the only route at narrow widths, where
    // mobile.css hides the grip for space. Deliberately not gated on viewport
    // width: hiding the grip there would otherwise strip the accessible path
    // and leave nothing in its place.
    //
    // The primitive owns the binding, the bounds and the announcement; it
    // consumes the press whether or not a move was possible, so an Alt+Arrow
    // in the trailing blank (which is not an item, so `i` is outside its
    // range) is refused there rather than guarded here.
    if (dnd.moveByKey(e, i, column)) return
    const row = displayed[i]
    const empty = isBlankRow(row)
    if (e.key === 'Enter') {
      e.preventDefault()
      // Return in a row that is already wholly empty must not insert another
      // blank (from ['Elections'], focusing the trailing blank and pressing
      // Return twice would otherwise yield ['Elections','','','']) — indices
      // that are no longer last would sprout grips and ordinals and become
      // reorderable, contradicting the rule that the trailing blank is not a
      // tag. Land in a further empty row if one exists; otherwise do nothing.
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
    // Positioned so it is the containing block for the two absolutely
    // positioned SR_ONLY elements below (the sort button's hidden span and
    // the aria-live status region) — both are `position: absolute` with no
    // offsets, so without a positioned ancestor here they'd resolve against
    // whatever distant positioned ancestor happens to exist, or the initial
    // containing block. Do not remove this as redundant.
    <div style={{ position: 'relative' }}>
      {/* The shortcut, once, for aria-describedby to point at. Rendered here,
          immediately before the table it describes, rather than after the
          table — a screen-reader user browsing linearly
          used to hit this sentence as a stray orphan at the very end of the
          whole control, attached (via aria-describedby) to fields far above
          it. It stays in the DOM regardless of scroll position, and its id is
          unchanged, so every aria-describedby reference above still resolves.
          Not a live region and not per row: it is a static description of the
          first row's fields (see hintFor above), so it says the sentence once,
          not once per row. The wording comes from the primitive's own
          constant so it cannot drift from the grip's accessible name. */}
      <span id={hintId} style={SR_ONLY}>{`To reorder this tag: ${REORDER_KEY_HINT}`}</span>

      <div className="tag-table" style={{ border: `1px solid ${color.borderDefault}`, borderRadius: radius.lg, overflow: 'hidden' }}>
        <div className="tag-table-row" style={{ display: 'grid', gridTemplateColumns: GRID_TEMPLATE_COLUMNS, background: color.surfaceSubtle, borderBottom: `1px solid ${color.borderDefault}` }}>
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
                  hidden with the shared SR_ONLY style, the same one the live
                  region below uses. */}
              <span style={SR_ONLY}>
                {!canReorder
                  ? ', rows cannot be reordered by name.'
                  : sortDirection === 'none'
                    ? ', unsorted. Click to sort A to Z.'
                    : sortDirection === 'asc'
                      ? ', sorted A to Z. Click to sort Z to A.'
                      : ', sorted Z to A. Click to sort A to Z.'}
              </span>
              <span aria-hidden="true" style={{ marginLeft: 3, fontSize: fontSize.xs, opacity: sortDirection === 'none' ? 0.4 : 1 }}>
                {sortDirection === 'none' ? '▲▼' : sortDirection === 'asc' ? '▼' : '▲'}
              </span>
            </button>
          </span>
          <span style={{ ...headStyle, borderLeft: `1px solid ${color.borderDefault}` }}>Description (optional)</span>
          <span style={headStyle} />
        </div>

        {displayed.map((row, i) => {
          const problem = problems[i]
          const msgId = `${idPrefix}-tag-problem-${i}`
          // This table's grip is not a Tab stop (see gripTabStop above), so
          // its accessible name — otherwise the only place the shortcut is
          // stated — is never reached by tabbing a row. The shortcut still
          // has to be discoverable from the fields themselves; see the two
          // mechanisms below (aria-keyshortcuts on every real row, the prose
          // hint on the first).
          const isTrailingBlank = i === displayed.length - 1
          // The prose hint is recited only once, on the first real row: every
          // real row's fields already carry aria-keyshortcuts (below), and
          // pointing all thirty rows' worth of fields at the same
          // aria-describedby text made tabbing a 30-tag taxonomy speak "To
          // reorder this tag: Press Alt with the up or down arrow keys." on
          // every focus — sixty times, on top of the visible hint already
          // shown above the table. One recital per traversal is enough.
          const hintFor = isTrailingBlank || i !== 0 ? undefined : hintId
          const describedBy = [problem ? msgId : undefined, hintFor].filter(Boolean).join(' ') || undefined
          // aria-keyshortcuts is the attribute built for exactly this: it
          // costs no speech in readers that ignore it, unlike a describedby
          // hint repeated on every row. It goes on every REAL row's fields
          // (not just the first) so the shortcut is still discoverable from
          // any row, not only the one that gets the prose recital. The
          // trailing blank isn't a tag and can't be reordered, so it gets
          // neither.
          const shortcutsFor = isTrailingBlank ? undefined : 'Alt+ArrowUp Alt+ArrowDown'
          // The trailing blank is the primitive's append-at-end slot, not an
          // item — it is a valid hover/drop target but never a drag source, and
          // it carries no item index.
          const showIndicator = isTrailingBlank ? dnd.indicatorAtEnd() : dnd.indicatorBefore(i)
          return (
            <Fragment key={i}>
              {showIndicator && <DropIndicator className="tag-table-drop-indicator" />}
              <div
                className="tag-table-row"
                style={{
                  display: 'grid',
                  gridTemplateColumns: GRID_TEMPLATE_COLUMNS,
                  borderTop: i === 0 ? undefined : `1px solid ${color.borderNeutralFaint}`,
                  background: problem ? color.bgDangerSoft : undefined,
                  ...dnd.sourceStyle(i),
                }}
                // The drop target is the WHOLE row, not the 34px grip: the grip
                // is only ~10% of the row's width, and without a dragover
                // preventDefault the browser shows "no drop allowed" over the
                // tag input, the description, and the delete cell — i.e. over
                // almost everywhere someone actually releases the pointer.
                // `draggable` stays on the grip, so the grip remains the only
                // thing that can START a drag.
                //
                // The primitive's handlers bail out when no reorder is in
                // progress — i.e. this drag did not originate from a grip.
                // Without that, preventDefault would run for ANY drag over a
                // real row, including a user dragging selected text toward a
                // description textarea, silently swallowing the browser's
                // native "insert at caret" drop.
                {...(isTrailingBlank ? dnd.tailDropProps() : dnd.dropProps(i))}
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
                    style={{ display: 'flex', alignItems: 'baseline', padding: '9px 4px 0 8px', gap: 4 }}
                    {...dnd.gripProps(i)}
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
                    aria-describedby={describedBy}
                    aria-keyshortcuts={shortcutsFor}
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
                    aria-describedby={hintFor}
                    aria-keyshortcuts={shortcutsFor}
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

      {/* The polite live region for reorder announcements, absolutely
          positioned (SR_ONLY), which is why the wrapper above is relative. */}
      <ReorderLiveRegion announcement={dnd.announcement} />
    </div>
  )
}

function resizeTextarea(ta: HTMLTextAreaElement) {
  ta.style.height = 'auto'
  ta.style.height = `${Math.max(ta.scrollHeight, 34)}px`
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
