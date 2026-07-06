import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { color, fontSize } from '../../styles/tokens'
import { DateDivider } from '../ui/DateDivider'
import { type CalendarEvent, todayIso, isPastDate } from '../../lib/calendarGrid'
import { computeSpacerHeight, agendaFooterLabel } from '../../lib/agendaLayout'
import { EventItem } from './EventItem'
import type { BillOption } from '../BillPicker'
import type { EventFormValues } from './EventFormFields'
import { formatDateHeader, formatTodayHeader } from '../../lib/calendarDate'

// Breathing room between the sticky header and today's row when scrolled to top.
const TOP_GAP = 12

// ⚠️ Email twin: api/src/lib/weekAheadEmail.ts renders the same date-grouped
// agenda (days → event cards) in email HTML, and event cards here are the
// agenda deep-link target for the email (?focusEvent=). Keep the two in mind
// together when changing the agenda's structure.
export function AgendaView({ events, isAdmin, onEdit, onDelete, onRestore, loaded, headerHeight, billOptions, editingId, onEditSave, onEditCancel, focusEventId, onFocusHandled }: {
  events: CalendarEvent[]
  isAdmin: boolean
  onEdit: (e: CalendarEvent) => void
  onDelete: (e: CalendarEvent) => void
  onRestore: (e: CalendarEvent) => void
  loaded: boolean
  headerHeight: number
  billOptions: BillOption[]
  editingId: string | null
  onEditSave: (v: EventFormValues) => void
  onEditCancel: () => void
  /** When set, scroll this event's date group to the top and flash the event. */
  focusEventId?: string | null
  /** Called once the focus target has been scrolled to + flashed. */
  onFocusHandled?: () => void
}) {
  const today = todayIso()
  const rootRef = useRef<HTMLDivElement>(null)
  const todayRef = useRef<HTMLDivElement>(null)
  const footerRef = useRef<HTMLDivElement>(null)
  const spacerRef = useRef<HTMLDivElement>(null)
  const didScrollRef = useRef(false)
  const userMovedRef = useRef(false)
  const [flashId, setFlashId] = useState<string | null>(null)
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const handledFocusRef = useRef<string | null>(null)

  const sorted = [...events].filter(e => e.date).sort((a, b) =>
    (a.date! + (a.time ?? '')).localeCompare(b.date! + (b.time ?? '')))

  const groups: Array<{ date: string; items: CalendarEvent[] }> = []
  for (const ev of sorted) {
    const last = groups[groups.length - 1]
    if (last && last.date === ev.date) last.items.push(ev)
    else groups.push({ date: ev.date!, items: [ev] })
  }
  // Ensure today always appears, in sorted position.
  if (!groups.some(g => g.date === today)) {
    groups.push({ date: today, items: [] })
    groups.sort((a, b) => a.date.localeCompare(b.date))
  }

  // Size the trailing spacer imperatively (not via state) so its height lands in
  // the DOM synchronously, before the scroll effect below runs in the same commit.
  // Using state here loses the initial-scroll on remount (Month → Agenda): the
  // scroll would fire a render before the new spacer is applied, capping the
  // scroll range. Recomputed on data change, header-height change, and resize.
  useLayoutEffect(() => {
    const measure = () => {
      const main = rootRef.current?.closest('main')
      const todayEl = todayRef.current
      const footerEl = footerRef.current
      const spacerEl = spacerRef.current
      if (!main || !todayEl || !footerEl || !spacerEl) return
      // Both rects are in viewport coords within the same scroll container, so the
      // difference is scroll-position-invariant (a shared scrollTop cancels out).
      const heightBelowTodaysTop = footerEl.getBoundingClientRect().bottom - todayEl.getBoundingClientRect().top
      spacerEl.style.height = `${computeSpacerHeight(main.clientHeight, headerHeight + TOP_GAP, heightBelowTodaysTop)}px`
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [events, headerHeight, loaded])

  // Scroll the agenda's OWN scroll container (main) so `el` lands just below the
  // sticky header. Deliberately NOT scrollIntoView: that scrolls every scrollable
  // ancestor, and on mobile the document is taller than the visual viewport
  // (100vh vs the dynamic browser URL bar), so scrollIntoView also scrolls the
  // window and pushes the fixed top bar off-screen. Scrolling main directly never
  // moves the window. scrollTo clamps to the scroll range, so distant targets
  // simply scroll as far as possible (matching "won't scroll past today").
  const pinToTop = useCallback((el: HTMLElement | null) => {
    if (!el) return
    const main = rootRef.current?.closest('main') as HTMLElement | null
    if (!main) return
    const target = main.scrollTop + (el.getBoundingClientRect().top - main.getBoundingClientRect().top) - (headerHeight + TOP_GAP)
    main.scrollTo({ top: Math.max(0, target) })
  }, [headerHeight])

  // Once the user actively scrolls (wheel/touch/keys), stop auto-pinning to today
  // so a late layout settle can never yank their position out from under them.
  useEffect(() => {
    const main = rootRef.current?.closest('main')
    if (!main) return
    const mark = () => { userMovedRef.current = true }
    main.addEventListener('wheel', mark, { passive: true })
    main.addEventListener('touchmove', mark, { passive: true })
    main.addEventListener('keydown', mark)
    return () => {
      main.removeEventListener('wheel', mark)
      main.removeEventListener('touchmove', mark)
      main.removeEventListener('keydown', mark)
    }
  }, [loaded])

  // Pin today to the top on mount (initial load AND each Month → Agenda toggle,
  // since AgendaView unmounts on Month), re-pinning whenever the header height
  // changes — until the user takes over (userMovedRef). Not keyed on data, so
  // adding or editing an event never yanks the user's scroll position.
  //
  // Why re-pin on headerHeight, not scroll-once: today's scrollMarginTop is
  // headerHeight + TOP_GAP, and the header height isn't stable at first paint.
  // (a) On the deferred-nav path `loaded` is true on the first render (events
  // seeded from router state), so this child effect runs before the parent
  // measures the header (headerHeight 0 → a 12px margin would land today UNDER
  // the header). (b) On mobile the header reflows on web-font load — buttons wrap
  // to two rows under the fallback font (taller), then collapse (shorter) — so a
  // single early scroll lands today too low once the header shrinks. Gating on
  // headerHeight > 0 and re-pinning on each measured change makes the final
  // resting position correct regardless of when the header settles.
  useLayoutEffect(() => {
    if (!loaded || didScrollRef.current || focusEventId || headerHeight === 0 || userMovedRef.current) return
    pinToTop(todayRef.current)
  }, [loaded, focusEventId, headerHeight, pinToTop])

  // Focus a specific hearing (from a sidebar deep-link): scroll its date group to
  // where TODAY normally sits and flash the event. Runs in a layout effect with an
  // instant scroll (like the today-scroll above) so it happens BEFORE paint — the
  // user never sees the list scrolled to the top (past events) first. pinToTop
  // clamps to the scroll range, so distant targets simply scroll as far as
  // possible — matching "won't scroll past TODAY" when few hearings remain.
  useLayoutEffect(() => {
    if (!focusEventId) { handledFocusRef.current = null; return }
    if (!loaded || handledFocusRef.current === focusEventId) return
    const targetDate = events.find(e => e.id === focusEventId)?.date
    if (!targetDate) return
    handledFocusRef.current = focusEventId
    didScrollRef.current = true // suppress the today-scroll
    pinToTop(document.getElementById(`agenda-date-${targetDate}`) as HTMLElement | null)
    setFlashId(focusEventId)
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current)
    flashTimerRef.current = setTimeout(() => { setFlashId(null); flashTimerRef.current = null }, 1500)
    onFocusHandled?.()
  }, [loaded, focusEventId, events, onFocusHandled, pinToTop])

  return (
    <div ref={rootRef}>
      {groups.map(g => {
        const isToday = g.date === today
        return (
          <div key={g.date} id={`agenda-date-${g.date}`} ref={isToday ? todayRef : undefined} style={{ marginBottom: 8, scrollMarginTop: headerHeight + TOP_GAP }}>
            <DateDivider label={isToday ? formatTodayHeader(g.date) : formatDateHeader(g.date)} isToday={isToday} stickyTop={headerHeight} />
            {g.items.length === 0
              ? <div style={{ fontSize: fontSize.xs, color: color.textMuted }}>No events.</div>
              : g.items.map(ev => (
                  <EventItem
                    key={ev.id}
                    event={ev}
                    isPast={isPastDate(g.date, today)}
                    isAdmin={isAdmin}
                    editing={ev.id === editingId}
                    flashing={ev.id === flashId}
                    billOptions={billOptions}
                    onEdit={onEdit}
                    onEditSave={onEditSave}
                    onEditCancel={onEditCancel}
                    onDelete={onDelete}
                    onRestore={onRestore}
                  />
                ))}
          </div>
        )
      })}
      <div ref={footerRef} style={{ textAlign: 'center', fontSize: fontSize.xs, color: color.textMuted, padding: '8px 0' }}>
        {agendaFooterLabel(sorted, today)}
      </div>
      <div ref={spacerRef} aria-hidden="true" />
    </div>
  )
}
