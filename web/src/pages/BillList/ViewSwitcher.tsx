import { useState, useEffect, useRef } from 'react'
import { color, radius, fontSize, fontWeight, shadow } from '../../styles/tokens'
import { useDismissOnOutsideClick } from '../../hooks/useDismissOnOutsideClick'
import { HoverTooltip } from '../../components/HoverTooltip'
import { inlineEditSaveStyle, inlineEditCancelStyle } from '../../lib/inlineEditStyles'
import { findActiveView } from '../../lib/savedViews'
import { apiFetch } from '../../lib/api'
import { countBadge } from '../../lib/chipStyles'
import { VIEW_STYLE } from '../../../../shared/viewStyle'
import { useDemo } from '../../context/DemoContext'
import { DropIndicator, ReorderLiveRegion, useDragReorder } from '../../components/dragReorder'

// Fixed dropdown width (FIX 2): the menu used to be content-sized off a
// `minWidth: 232` floor, so revealing Rename/Delete on hover widened the whole
// menu. Fixing the width instead makes the name column shrink (it already
// carries flex/minWidth/textOverflow) so the row layout never jumps. 272px was
// 232 (the old floor, comfortable for name + count alone) plus room for the
// Rename and Delete buttons (~2-3 chars + padding each) so the two-button row
// still shows a readable slice of the name rather than truncating it away.
// Raised to 300px for a third control. All three are now glyph buttons rather
// than words, which needs less room than the figure assumed — the surplus goes
// to the name column, so it is left as-is rather than tightened.
const MENU_WIDTH = 300

export type SavedView = { id: string; name: string; query: string; slug?: string; previousSlug?: string | null }

// Sentinel key for the "All bills" row's count, distinct from any view id.
const ALL_BILLS_KEY = '__all_bills__'

// Count badge for a view row — same COUNT_BADGE treatment FilterDropdown uses
// (see chipStyles' countBadge()), but with three states instead of one: a
// loaded count (a number), an in-flight count (renders a neutral placeholder,
// never 0 — a wrong zero reads as "no matches"), or a failed count (renders
// nothing at all, rather than a misleading number).
function ViewCountBadge({ count, failed }: { count: number | undefined; failed: boolean }) {
  if (failed) return null
  return (
    <span style={{ ...countBadge(), marginLeft: 'auto', flexShrink: 0 }}>
      {count === undefined ? '…' : count.toLocaleString()}
    </span>
  )
}

export function ViewSwitcher({
  views, currentSearch, isAdmin, onApply, onRename, onDelete, onReorder, onOverwrite,
}: {
  views: SavedView[]
  currentSearch: string
  isAdmin: boolean
  onApply: (view: SavedView | null) => void
  onRename: (id: string, name: string) => void | Promise<void>
  onDelete: (id: string) => void | Promise<void>
  onReorder: (order: string[]) => void | Promise<void>
  onOverwrite: (id: string) => void | Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [draftName, setDraftName] = useState('')
  const [confirmingId, setConfirmingId] = useState<string | null>(null)
  // Separate from confirmingId (delete's confirm state) — overwrite is a
  // distinct destructive action with its own wording, and a row must not be
  // able to show both confirms at once.
  const [confirmingOverwriteId, setConfirmingOverwriteId] = useState<string | null>(null)
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  // Local, optimistic ordering of `views` — reordered immediately on drop and
  // reverted if onReorder rejects. Reset from props whenever the incoming
  // views identity/order changes (a fresh fetch, a rename/delete reload).
  const [orderedViews, setOrderedViews] = useState<SavedView[]>(views)
  useEffect(() => {
    setOrderedViews(views)
  }, [views])
  // Rename/Delete must also be reachable without a mouse — mouseenter never
  // fires on touch, and tabbing to a row doesn't set hoveredId. onFocus/onBlur
  // on the row wrapper catch focus landing on (or leaving) any descendant,
  // since React's focus events bubble.
  const [focusedId, setFocusedId] = useState<string | null>(null)
  const ref = useDismissOnOutsideClick(open, () => setOpen(false))
  const { demoMode, settled } = useDemo()
  // Hide any control that writes until we positively know this tenant is not
  // a demo — demoMode === false is ambiguous before `settled`, and a naive
  // `!demoMode` would flash Rename/Delete at a demo visitor on first render.
  const isNotDemo = settled && !demoMode
  // Reorder is a write, gated the same as Rename/Delete: an admin, on a tenant
  // positively known not to be a demo.
  const canReorder = isAdmin && isNotDemo

  // Drag- and keyboard-reorder, shared with the tag table
  // (admin/TagTaxonomyTable.tsx) and custom fields (admin/Config.tsx) — see
  // components/dragReorder.tsx. Declared up here, above the
  // `views.length === 0` early return below, because it is a hook. Persistence
  // stays at this call site: commitReorder is optimistic and reverts on
  // failure, which neither of the other two lists does — and it does so for a
  // keyboard move exactly as for a drop, there being one route through the
  // primitive and not two.
  //
  // `to` arrives already adjusted for the splice-out shift, and only for a move
  // the primitive accepted, so commitReorder needs neither the arithmetic nor a
  // no-op guard it used to carry.
  //
  // The grip is the only keyboard route into this list, so it is a Tab stop —
  // the primitive's default. `disabled` covers the gate this list has always
  // had (an admin, on a tenant positively known not to be a demo); a disabled
  // grip is neither focusable nor labelled with a shortcut it cannot honour,
  // and this list renders no grip at all in that case anyway.
  const dnd = useDragReorder({
    count: orderedViews.length,
    disabled: !canReorder,
    label: i => orderedViews[i].name,
    onReorder: (from, to) => { void commitReorder(from, to) },
  })

  // Closing the menu abandons any in-progress rename or delete confirm, so
  // reopening never resumes a half-finished destructive action. It also drops
  // hover/focus row state: clicking a row's Rename/Delete sets focusedId via
  // the row's onFocus, and when the menu closes that button unmounts — an
  // unmounting element doesn't reliably fire blur, so focusedId (and, if the
  // pointer left via the menu vanishing rather than a mouseleave, hoveredId)
  // could otherwise survive to the next open and show buttons on a row no
  // one is touching.
  useEffect(() => {
    if (open) return
    setRenamingId(null)
    setConfirmingId(null)
    setConfirmingOverwriteId(null)
    setHoveredId(null)
    setFocusedId(null)
  }, [open])

  // Match counts, keyed by view id (or ALL_BILLS_KEY for "All bills"). Fetched
  // lazily on menu-open rather than on page load: most page loads never open
  // this menu, and each count is its own /bills query, so the cost should only
  // land when someone actually looks. fetchedKeysRef persists for the life of
  // the component, so reopening the menu never refetches an already-resolved
  // (or already-failed) count.
  const [viewCounts, setViewCounts] = useState<Record<string, number>>({})
  const [failedCounts, setFailedCounts] = useState<Set<string>>(new Set())
  const fetchedKeysRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    if (!open) return
    const targets: Array<{ key: string; query: string }> = [
      { key: ALL_BILLS_KEY, query: '' },
      ...orderedViews.map(v => ({ key: v.id, query: v.query })),
    ]
    for (const { key, query } of targets) {
      if (fetchedKeysRef.current.has(key)) continue
      fetchedKeysRef.current.add(key)
      // pageSize=1 so this costs a count, not a page of rows — each view's
      // stored query is already a valid /bills filter string.
      const params = new URLSearchParams(query)
      params.set('page', '1')
      params.set('pageSize', '1')
      apiFetch<{ pagination: { total: number } }>(`/bills?${params.toString()}`)
        .then(data => setViewCounts(prev => ({ ...prev, [key]: data.pagination.total })))
        .catch(() => setFailedCounts(prev => new Set(prev).add(key)))
    }
  }, [open, orderedViews])

  // A tenant with no views gets no control at all — the h1 row is unchanged.
  if (views.length === 0) return null

  const active = findActiveView(currentSearch, orderedViews)

  // "Views", never "All bills": in the diverged state filters are applied and no
  // view matches, and "All bills" would misdescribe what is on screen.
  const label = active?.name ?? 'Views'

  function beginRename(v: SavedView) {
    setConfirmingId(null)
    setRenamingId(v.id)
    setDraftName(v.name)
  }

  async function commitRename() {
    const next = draftName.trim()
    if (!renamingId || !next) return
    try {
      await onRename(renamingId, next)
      setRenamingId(null)
    } catch {
      // Leave the row in its editing state so the user can see the rename
      // didn't take, instead of closing as though it had succeeded.
    }
  }

  async function commitDelete(id: string) {
    try {
      await onDelete(id)
      setConfirmingId(null)
    } catch {
      // Leave the confirm state open so the user can see the delete didn't
      // take, instead of closing as though it had succeeded.
    }
  }

  async function commitOverwrite(id: string) {
    try {
      await onOverwrite(id)
      setConfirmingOverwriteId(null)
    } catch {
      // Leave the confirm state open so the user can see the overwrite
      // didn't take, instead of closing as though it had succeeded.
    }
  }

  async function commitReorder(fromIdx: number, toIdx: number) {
    const previous = orderedViews
    const reordered = [...previous]
    const [moved] = reordered.splice(fromIdx, 1)
    reordered.splice(toIdx, 0, moved)
    // Optimistic: apply immediately so the drag feels instant.
    setOrderedViews(reordered)
    try {
      await onReorder(reordered.map(v => v.id))
    } catch {
      // Revert to the pre-drag order — a silent revert with no message would
      // look like the drag simply didn't take, so onReorder's caller is
      // expected to surface the error itself (mirroring onRename/onDelete).
      setOrderedViews(previous)
      // And correct the live region, which the primitive already set to
      // "...moved to position n of m" on the optimistic move. Leaving that
      // standing tells a screen-reader user the move succeeded at the exact
      // moment the list snaps back — the announcement has to revert with the
      // order it was describing.
      dnd.announce(`${moved.name} could not be moved. The list is unchanged.`)
    }
  }

  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          fontFamily: 'inherit', fontSize: fontSize.base,
          fontWeight: active ? fontWeight.semibold : fontWeight.medium,
          // VIEW_STYLE, not the filter blue: this trigger's color means "a view
          // is applied," a distinct signal from "a filter is on." Resting state
          // stays neutral so a quiet control doesn't imply a view is active.
          color: active ? VIEW_STYLE.text : color.textSecondary,
          background: 'none', border: 'none', cursor: 'pointer',
          padding: '3px 7px', borderRadius: radius.md,
          display: 'inline-flex', alignItems: 'center', gap: 5, whiteSpace: 'nowrap',
        }}
      >
        {label}
        <svg width="10" height="6" viewBox="0 0 10 6" fill="none" aria-hidden="true">
          <path
            d={open ? 'M1 5l4-4 4 4' : 'M1 1l4 4 4-4'}
            stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
          />
        </svg>
      </button>
      {open && (
        <div
          role="group"
          aria-label="Saved views"
          style={{
            position: 'absolute', top: 'calc(100% + 4px)', left: 0, zIndex: 300,
            background: color.white, border: `1px solid ${color.borderDefault}`,
            borderRadius: radius.lg, padding: '4px 0', width: MENU_WIDTH, maxHeight: 300, overflowY: 'auto',
            boxShadow: shadow.md,
          }}
        >
          <button
            onClick={() => { onApply(null); setOpen(false) }}
            style={rowStyle(!active)}
          >
            All bills
            <ViewCountBadge count={viewCounts[ALL_BILLS_KEY]} failed={failedCounts.has(ALL_BILLS_KEY)} />
          </button>
          <div style={{ height: 1, background: color.borderDefault, margin: '4px 0' }} />
          {orderedViews.map((v, i) => {
            // The views layer's own teal, not the primitive's default blue —
            // this line belongs to the same surface as the selected row.
            const indicator = dnd.indicatorBefore(i) && <DropIndicator lineColor={VIEW_STYLE.border} />
            // Any row can be a drop target regardless of its state, but only a
            // row that is neither being renamed nor confirming delete may be
            // the drag *source* — those two branches render no grip at all.
            const dropHandlers = dnd.dropProps(i)
            if (renamingId === v.id) {
              return (
                <div key={v.id}>
                  {indicator}
                  <div style={{ ...rowStyle(false), cursor: 'default', gap: 6, ...dnd.sourceStyle(i) }} {...dropHandlers}>
                    <input
                      aria-label="View name"
                      value={draftName}
                      onChange={e => setDraftName(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter') commitRename()
                        if (e.key === 'Escape') setRenamingId(null)
                      }}
                      style={{
                        flex: 1, minWidth: 0, fontFamily: 'inherit', fontSize: fontSize.sm,
                        padding: '3px 7px', border: `1px solid ${color.accentBlue}`,
                        borderRadius: radius.sm, color: color.textPrimary,
                      }}
                    />
                    <button onClick={commitRename} style={inlineEditSaveStyle()}>Save</button>
                    {/* Escape still cancels, but a keyboard-only affordance is
                        not a visible one — and the custom-fields form this now
                        matches has always shown the button. */}
                    <button onClick={() => setRenamingId(null)} style={inlineEditCancelStyle()}>Cancel</button>
                  </div>
                </div>
              )
            }
            if (confirmingId === v.id) {
              return (
                <div key={v.id}>
                  {indicator}
                  <div style={{ ...rowStyle(false), cursor: 'default', background: color.bgDangerSoft, color: color.textDanger, ...dnd.sourceStyle(i) }} {...dropHandlers}>
                    <span style={{ flex: 1, minWidth: 0, fontWeight: fontWeight.medium }}>Delete view for everyone?</span>
                    <button onClick={() => setConfirmingId(null)} style={smallButtonStyle('cancel')}>Cancel</button>
                    <button onClick={() => { void commitDelete(v.id) }} style={smallButtonStyle('danger')}>Delete</button>
                  </div>
                </div>
              )
            }
            if (confirmingOverwriteId === v.id) {
              return (
                <div key={v.id}>
                  {indicator}
                  <div style={{ ...rowStyle(false), cursor: 'default', background: color.bgDangerSoft, color: color.textDanger, ...dnd.sourceStyle(i) }} {...dropHandlers}>
                    {/* Overwrite loses more than delete does in one specific way:
                        a deleted view can be rebuilt from the filters still on
                        screen, but the previous filter set behind an overwritten
                        view has nothing to recover it. The wording says so. */}
                    <span style={{ flex: 1, minWidth: 0, fontWeight: fontWeight.medium }}>Replace this view's filters with the current ones?</span>
                    <button onClick={() => setConfirmingOverwriteId(null)} style={smallButtonStyle('cancel')}>Cancel</button>
                    <button onClick={() => { void commitOverwrite(v.id) }} style={smallButtonStyle('danger')}>Replace</button>
                  </div>
                </div>
              )
            }
            const isActive = active?.id === v.id
            // Only draggable via this handle, not the whole row: the row's
            // name button applies the view and closes the menu on click, so
            // making the entire row draggable would risk that click firing
            // mid-drag and closing the popup out from under the interaction.
            // The accessible name comes from the primitive (it names the view
            // and the Alt+Arrow shortcut), not from a local aria-label: a grip
            // that says "Reorder Alpha" and nothing else tells a keyboard user
            // what it is for but not how to use it.
            const grip = canReorder && (
              <span
                {...dnd.gripProps(i)}
                style={{
                  fontSize: fontSize.base, color: color.borderStrong, cursor: 'grab',
                  userSelect: 'none', flexShrink: 0, lineHeight: 1,
                }}
              >⠿</span>
            )
            return (
              <div key={v.id}>
                {indicator}
                <div
                  onMouseEnter={() => setHoveredId(v.id)}
                  onMouseLeave={() => setHoveredId(null)}
                  onFocus={() => setFocusedId(v.id)}
                  onBlur={() => setFocusedId(null)}
                  style={{ ...rowStyle(isActive), cursor: 'default', ...dnd.sourceStyle(i) }}
                  {...dropHandlers}
                >
                  {grip}
                  <button
                    onClick={() => { onApply(v); setOpen(false) }}
                    style={{
                      flex: '0 1 auto', minWidth: 0, textAlign: 'left', background: 'none',
                      border: 'none', padding: 0, cursor: 'pointer', font: 'inherit',
                      color: 'inherit', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}
                  >
                    {v.name}
                  </button>
                  {/* Rename hugs the name, as it does on a custom-field row.
                      Everything else is pushed to the far side by the spacer
                      below, so the row reads name-then-actions rather than one
                      huddle on the left. Tooltips are HoverTooltip, not the
                      native `title` attribute: title waits about a second and
                      never fires on touch, which for an icon-only control is
                      the whole explanation missing. */}
                  {isAdmin && isNotDemo && (hoveredId === v.id || focusedId === v.id) && (
                    <HoverTooltip text={`Rename "${v.name}"`}>
                      <button
                        onClick={() => beginRename(v)}
                        aria-label={`Rename "${v.name}"`}
                        style={iconGlyphButtonStyle}
                      >
                        <span className="material-symbols-outlined" style={{ fontSize: fontSize.base }}>edit</span>
                      </button>
                    </HoverTooltip>
                  )}
                  <span style={{ flex: 1 }} />
                  {isAdmin && isNotDemo && (hoveredId === v.id || focusedId === v.id) && (
                    <span style={{ display: 'flex', gap: 2, flex: 'none' }}>
                      {/* The `save` glyph is a floppy disk and reads oddly for
                          "replace this view's saved filters with the ones on
                          screen now" — that mismatch is accepted, so the
                          accessible name and tooltip (not the icon) carry what
                          the control actually does. */}
                      <HoverTooltip text="Replace this view's filters with the current ones">
                        <button
                          onClick={() => { setRenamingId(null); setConfirmingId(null); setConfirmingOverwriteId(v.id) }}
                          aria-label="Replace this view's filters with the current ones"
                          style={iconGlyphButtonStyle}
                        >
                          <span className="material-symbols-outlined" style={{ fontSize: fontSize.base }}>save</span>
                        </button>
                      </HoverTooltip>
                      <HoverTooltip text={`Delete "${v.name}"`}>
                        <button
                          onClick={() => { setRenamingId(null); setConfirmingOverwriteId(null); setConfirmingId(v.id) }}
                          aria-label={`Delete "${v.name}"`}
                          style={{ ...iconGlyphButtonStyle, color: color.textErrorRed }}
                        >
                          <span className="material-symbols-outlined" style={{ fontSize: fontSize.base }}>delete</span>
                        </button>
                      </HoverTooltip>
                    </span>
                  )}
                  <ViewCountBadge count={viewCounts[v.id]} failed={failedCounts.has(v.id)} />
                </div>
              </div>
            )
          })}
          {/* The append-at-end zone, which insert-before semantics cannot
              otherwise reach. Not a special case in the primitive: it is
              simply slot `count`. */}
          {canReorder && (
            <div {...dnd.tailDropProps()} style={{ minHeight: 6 }}>
              {dnd.indicatorAtEnd() && <DropIndicator lineColor={VIEW_STYLE.border} />}
            </div>
          )}
        </div>
      )}
      {/* Outside the popup, so an announcement is not torn out of the
          accessibility tree the moment the menu closes, and inside this
          wrapper, which is the relative ancestor SR_ONLY needs. */}
      <ReorderLiveRegion announcement={dnd.announcement} />
    </div>
  )
}

// FIX 3, the vertical twin of FIX 2 above: at rest a row is just the name and
// its count badge (fontSize.sm), but hovering reveals three glyph buttons whose
// boxes are taller than that, so the row grew and every row below it shifted
// under the pointer. minHeight pins the row to its hovered height — 18px of
// content (a fontSize.base glyph at lineHeight 1, plus the buttons' 1px
// padding) over the 14px of row padding — so revealing the controls can no
// longer change it. alignItems: center keeps the shorter resting content
// centred in that space.
const ROW_MIN_HEIGHT = 32

function rowStyle(selected: boolean): React.CSSProperties {
  return {
    display: 'flex', alignItems: 'center', gap: 8, padding: '7px 12px', minHeight: ROW_MIN_HEIGHT, boxSizing: 'border-box',
    fontSize: fontSize.sm, width: '100%', textAlign: 'left',
    fontFamily: 'inherit', border: 'none', cursor: 'pointer',
    // VIEW_STYLE, not the filter blue's bgInfo/linkBlue — a selected view row
    // is a distinct signal from "a filter is on."
    background: selected ? VIEW_STYLE.bg : 'transparent',
    color: selected ? VIEW_STYLE.text : color.textSlate,
  }
}

// Config.tsx's row-action icon idiom: a bare material-symbols-outlined glyph
// with no text label, its meaning carried by aria-label and title. All three
// row actions use it, so the row reads as one set rather than a mix of words
// and symbols. Delete additionally overrides the colour to textErrorRed,
// matching the custom-fields row it borrows from.
const iconGlyphButtonStyle: React.CSSProperties = {
  fontFamily: 'inherit', background: 'none', border: 'none', cursor: 'pointer',
  color: color.textSecondary, padding: '1px 4px', borderRadius: radius.sm,
  display: 'inline-flex', alignItems: 'center', lineHeight: 1,
}

function smallButtonStyle(kind: 'danger' | 'cancel'): React.CSSProperties {
  const base: React.CSSProperties = {
    fontFamily: 'inherit', fontSize: fontSize.xs, padding: '2px 8px',
    borderRadius: radius.sm, cursor: 'pointer', whiteSpace: 'nowrap',
  }
  if (kind === 'danger') return { ...base, border: `1px solid ${color.borderRedChip}`, background: color.white, color: color.textDanger, fontWeight: fontWeight.semibold }
  return { ...base, border: `1px solid ${color.borderDefault}`, background: color.white, color: color.textSecondary }
}
