import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams, useLoaderData, type LoaderFunctionArgs } from 'react-router-dom'
import { apiFetch } from '../lib/api'
import { apiFetchForLoader } from '../lib/loaderFetch'
import { useMultiState } from '../context/ConfigContext'
import { useDemo } from '../context/DemoContext'
import { useAuth } from '../hooks/useAuth'
import { usePageTitle } from '../hooks/usePageTitle'
import { color, radius, fontSize, fontWeight } from '../styles/tokens'
import type { CalendarEvent } from '../lib/calendarGrid'
import { AgendaView } from '../components/calendar/AgendaView'
import { MonthGrid } from '../components/calendar/MonthGrid'
import { EventPopover, computeEventPopoverPosition, type EventPopoverPosition } from '../components/calendar/EventPopover'
import { DayPopover, computeDayPopoverPosition } from '../components/calendar/DayPopover'
import type { PopPanelHandle } from '../components/ui/PopPanel'
import { EventForm, type EventFormValues } from '../components/calendar/EventForm'
import { SubscribeCalendar } from '../components/calendar/SubscribeCalendar'
const ImportEvents = lazy(() => import('../components/calendar/ImportEvents').then(m => ({ default: m.ImportEvents })))
import type { BillOption } from '../components/BillPicker'
import { getScrollContainer } from '../lib/scrollUtils'
import { useIsBreakpoint } from '../hooks/use-is-breakpoint'
import type { Box } from '../components/calendar/expandTarget'
import { clampTargetFor } from '../components/calendar/expandBounds'

// Route loader: fetch events before the calendar renders (RR7 data router).
//
// `request.signal` is not optional in practice, exactly as in billDetailLoader
// and prefetchBills: apiFetchForLoader retries until it succeeds or aborts, so a
// run nobody cancels outlives its navigation and keeps hitting a struggling API
// for the life of the tab, holding retryFetch's visibilitychange/online
// listeners. RR7 fires this signal for every loader run that never commits — an
// abandoned navigation, a superseded revalidation — which is precisely that run.
export function calendarLoader({ request }: LoaderFunctionArgs): Promise<CalendarEvent[]> {
  return apiFetchForLoader<CalendarEvent[]>('/calendar/events', { signal: request.signal })
}

export function Calendar() {
  usePageTitle('Calendar')
  const { user } = useAuth()
  const { demoLocked } = useDemo()
  const isAdmin = user?.role === 'admin' || user?.role === 'owner'
  const isMobile = useIsBreakpoint('max', 768)

  // Events come from calendarLoader (RR7 data router) — resolved before render.
  const preloaded = useLoaderData() as CalendarEvent[]
  const [events, setEvents] = useState<CalendarEvent[]>(preloaded ?? [])
  const [loaded, setLoaded] = useState(!!preloaded)
  const skipFirstLoad = useRef(!!preloaded)
  const [view, setView] = useState<'agenda' | 'month'>('agenda')
  const [importing, setImporting] = useState(false)

  // Deep-link focus: ?focusEvent=<id|eventHash> scrolls the agenda to that event
  // and flashes it. The sidebar hearings widget passes an eventHash; the
  // week-ahead email passes the DB event id (custom events have no eventHash),
  // so match either.
  const [searchParams, setSearchParams] = useSearchParams()
  const focusEvent = searchParams.get('focusEvent')
  const focusEventId = useMemo(
    () => (focusEvent
      ? (events.find(e => e.id === focusEvent || e.eventHash === focusEvent || e.eventHashes?.includes(focusEvent))?.id ?? null)
      : null),
    [focusEvent, events],
  )
  useEffect(() => { if (focusEvent) setView('agenda') }, [focusEvent])
  const clearFocus = () => {
    const next = new URLSearchParams(searchParams)
    next.delete('focusEvent')
    setSearchParams(next, { replace: true })
  }
  const multiState = useMultiState()
  const [billOptions, setBillOptions] = useState<BillOption[]>([])
  const [popover, setPopover] = useState<{
    event: CalendarEvent
    position: EventPopoverPosition
    token: number
    alignRight: boolean
    expandFrom?: DOMRect
    computeTarget?: (h: number) => Box
  } | null>(null)
  const popoverPanelRef = useRef<PopPanelHandle>(null)
  const popoverTriggerRef = useRef<HTMLElement | null>(null)
  const tokenRef = useRef(0)
  const [dayPopover, setDayPopover] = useState<{ dateIso: string; events: CalendarEvent[]; position: EventPopoverPosition; token: number; alignRight: boolean } | null>(null)
  const dayPanelRef = useRef<PopPanelHandle>(null)
  const dayTriggerRef = useRef<HTMLElement | null>(null)
  const dayTokenRef = useRef(0)
  const [form, setForm] = useState<{
    initial?: EventFormValues
    position: EventPopoverPosition
    token: number
    clampPosition?: (h: number) => { left: number; top: number }
  } | null>(null)
  const formTokenRef = useRef(0)
  const formPanelRef = useRef<PopPanelHandle>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const addBtnRef = useRef<HTMLButtonElement>(null)
  const headerRef = useRef<HTMLDivElement>(null)
  const [headerHeight, setHeaderHeight] = useState(0)

  async function loadEvents() {
    const data = await apiFetch<CalendarEvent[]>('/calendar/events')
    setEvents(data)
    setLoaded(true)
  }

  useEffect(() => {
    if (skipFirstLoad.current) { skipFirstLoad.current = false; return }
    loadEvents().catch(() => {})
  }, [])

  useEffect(() => {
    if (isAdmin) {
      apiFetch<BillOption[]>('/calendar/bill-options')
        .then(setBillOptions)
        .catch(() => {})
    }
  }, [isAdmin])

  // Observe the sticky header's real height with a ResizeObserver, not just
  // mount + window-resize. The header reflows on web-font load (FOUT) — the
  // action buttons wrap to two rows under the fallback font, then collapse to
  // one when the font swaps in — which does NOT fire a resize event. Without
  // this, headerHeight goes stale and the agenda's scrollMarginTop (and thus the
  // scroll-to-today landing) is computed from the wrong header height.
  useLayoutEffect(() => {
    const el = headerRef.current
    if (!el) return
    const measure = () => setHeaderHeight(el.offsetHeight)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // The agenda scrolls the shared, persistent <main> to pin today. Reset it on
  // unmount so the next page (rendered in that same container) doesn't inherit
  // the scroll-to-today position. Pages that restore their own scroll (Bills)
  // run after this and override it.
  useEffect(() => () => { getScrollContainer().scrollTop = 0 }, [])

  const now = useMemo(() => new Date(), [])

  function selectEvent(e: CalendarEvent, anchor?: HTMLElement, alignRight = false) {
    // Same event already open → animated toggle-close.
    if (popover && popover.event.id === e.id) {
      popoverPanelRef.current?.close()
      return
    }
    const el = anchor ?? null
    popoverTriggerRef.current = el
    const rect = el ? el.getBoundingClientRect() : new DOMRect(8, 80, 0, 0)

    // Desktop month grid → expand in place. Mobile / no-anchor → current popover.
    const computeTarget = !isMobile ? clampTargetFor(el, rect) : null
    if (computeTarget) {
      setPopover({
        event: e,
        // `position` is unused in expand mode; kept for type/shape consistency.
        position: computeDayPopoverPosition(rect, { alignRight }),
        token: ++tokenRef.current,
        alignRight,
        expandFrom: rect,
        computeTarget,
      })
      return
    }

    // Cover the clicked event, springing from its top corner (top-right on the
    // Fri/Sat columns) — same gesture as the day popover.
    setPopover({ event: e, position: computeDayPopoverPosition(rect, { alignRight }), token: ++tokenRef.current, alignRight })
  }

  function selectDay(dateIso: string, dayEvents: CalendarEvent[], cellEl: HTMLElement, alignRight: boolean) {
    // Same day already open → animated toggle-close.
    if (dayPopover && dayPopover.dateIso === dateIso) {
      dayPanelRef.current?.close()
      return
    }
    dayTriggerRef.current = cellEl
    const rect = cellEl.getBoundingClientRect()
    setDayPopover({ dateIso, events: dayEvents, position: computeDayPopoverPosition(rect, { alignRight }), token: ++dayTokenRef.current, alignRight })
  }

  function openAdd() {
    // The header add form is already open → animated toggle-close (mirror
    // selectEvent/selectDay). `initial` undefined identifies the header add form.
    if (form && !form.initial) {
      formPanelRef.current?.close()
      return
    }
    const rect = addBtnRef.current?.getBoundingClientRect() ?? new DOMRect(8, 80, 0, 0)
    setForm({ position: computeEventPopoverPosition(rect, { width: 320, align: 'right', grow: true }), token: ++formTokenRef.current })
  }

  // Clicking a day starts a new event on that date; the form pops over the slot
  // the new card would occupy. On the desktop month grid it clamps to the
  // calendar edges (same machinery as the event expand); otherwise it springs
  // from the cell corner as before.
  function openAddForDay(dateIso: string, anchor: DOMRect, cellEl: HTMLElement, alignRight: boolean) {
    // Same day's add form already open → animated toggle-close (mirror selectDay).
    // A new-event form for this day has no id and its date is the clicked day.
    if (form && form.initial && !form.initial.id && form.initial.date === dateIso) {
      formPanelRef.current?.close()
      return
    }
    const target = !isMobile ? clampTargetFor(cellEl, anchor) : null
    setForm({
      initial: { description: '', date: dateIso, time: null, location: null, billIds: [], details: null, url: null },
      position: computeDayPopoverPosition(anchor, { width: 320, alignRight, grow: true }),
      // clampTargetFor returns a Box; PopPanel.clampPosition reads only left/top
      // (Box is structurally assignable), so pass the closure through directly.
      clampPosition: target ?? undefined,
      token: ++formTokenRef.current,
    })
  }

  async function saveEvent(v: EventFormValues) {
    if (v.id) {
      await apiFetch(`/calendar/events/${v.id}`, { method: 'PUT', body: JSON.stringify(v) })
    } else {
      // Capture the creator's browser zone — the ICS feed uses it as the fallback
      // timezone when an event's state can't be resolved (see calendarApi feed).
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
      await apiFetch('/calendar/events', { method: 'POST', body: JSON.stringify({ ...v, timezone }) })
    }
    setForm(null)
    setEditingId(null)
    await loadEvents()
  }

  async function deleteEvent(e: CalendarEvent) {
    if (demoLocked) return
    await apiFetch(`/calendar/events/${e.id}`, { method: 'DELETE' })
    setPopover(null)
    setDayPopover(null)
    await loadEvents()
  }

  async function restoreEvent(e: CalendarEvent) {
    if (demoLocked) return
    await apiFetch(`/calendar/events/${e.id}/restore`, { method: 'POST' })
    setPopover(null)
    setDayPopover(null)
    await loadEvents()
  }

  function openEditForm(e: CalendarEvent, triggerEl?: HTMLElement | null, alignRight = false) {
    const rect = triggerEl?.getBoundingClientRect() ?? addBtnRef.current?.getBoundingClientRect() ?? new DOMRect(8, 80, 0, 0)
    const target = !isMobile && triggerEl ? clampTargetFor(triggerEl, rect) : null
    setForm({
      initial: {
        id: e.id,
        description: e.description ?? '',
        date: e.date ?? '',
        time: e.time,
        location: e.location,
        billIds: e.bills.map(b => b.id),
        details: e.details ?? '',
        url: e.url ?? '',
      },
      // Cover the event card being edited (same gesture as the detail popover).
      position: computeDayPopoverPosition(rect, { width: 320, alignRight, grow: true }),
      // clampTargetFor returns a Box; PopPanel.clampPosition reads only left/top
      // (Box is structurally assignable), so pass the closure through directly.
      clampPosition: target ?? undefined,
      token: ++formTokenRef.current,
    })
  }

  // On phones the 7-col month grid is too cramped, so show Agenda only and hide
  // the toggle. Derive the effective view instead of mutating `view`, so a desktop
  // Month selection is restored if the window widens back across the breakpoint.
  const effectiveView = isMobile ? 'agenda' : view
  // The header/toolbar stays at the narrow width in both views so the buttons
  // never move; only the content below widens for the month grid.
  const contentMaxWidth = effectiveView === 'month' ? 1100 : 680

  // The day whose popover/form is open — MonthGrid outlines it 2px amber.
  const activeDateIso = popover?.event.date ?? form?.initial?.date ?? dayPopover?.dateIso ?? null

  // Switching views resets the scroll to the top — otherwise the scroll
  // container keeps the agenda's offset and the month grid opens partway down.
  // The layout scrolls inside <main class="app-main">, not the window.
  function switchView(v: 'agenda' | 'month') {
    setView(v)
    getScrollContainer().scrollTo({ top: 0, left: 0 })
  }

  const seg = (active: boolean): React.CSSProperties => ({
    padding: '5px 12px',
    fontSize: fontSize.sm,
    cursor: 'pointer',
    border: 'none',
    background: active ? color.bgAmberPriority : color.white,
    color: active ? color.billBadgeNavy : color.textSlate,
    // fontFamily (not the `font` shorthand) — `font: inherit` would reset font-size
    // back to the inherited 16px and clobber fontSize above.
    fontFamily: 'inherit',
  })

  return (
    <>
      <div
        ref={headerRef}
        className="agenda-sticky-header"
        style={{ position: 'sticky', top: 0, zIndex: 10, background: color.surfaceMuted }}
      >
        <div style={{ maxWidth: 680, margin: '0 auto', padding: '24px 20px 12px' }}>
          <h1 style={{ fontSize: fontSize.xxl, fontWeight: fontWeight.bold, color: color.textPrimary, margin: '0 0 12px' }}>Calendar</h1>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            {/* Month view is unusable on phones; the toggle only appears on desktop. */}
            {!isMobile && (
              <div style={{ display: 'inline-flex', border: `1px solid ${color.borderDefault}`, borderRadius: radius.md, overflow: 'hidden' }}>
                <button type="button" onClick={() => switchView('agenda')} style={seg(view === 'agenda')}>Agenda</button>
                <button type="button" onClick={() => switchView('month')} style={seg(view === 'month')}>Month</button>
              </div>
            )}
            <div style={{ flex: 1 }} />
            <SubscribeCalendar />
            {isAdmin && (
              <button
                type="button"
                onClick={() => setImporting(true)}
                style={{
                  background: color.white,
                  color: color.textSlate,
                  border: `1px solid ${color.borderDefault}`,
                  borderRadius: radius.md,
                  padding: '8px 14px',
                  fontSize: fontSize.sm,
                  fontWeight: fontWeight.semibold,
                  cursor: 'pointer',
                }}
              >
                Import events
              </button>
            )}
            {isAdmin && (
              <button
                ref={addBtnRef}
                type="button"
                onClick={openAdd}
                style={{
                  background: color.accentBlue,
                  color: color.white,
                  border: 'none',
                  borderRadius: radius.md,
                  padding: '8px 14px',
                  fontSize: fontSize.sm,
                  fontWeight: fontWeight.medium,
                  cursor: 'pointer',
                }}
              >
                Add event
              </button>
            )}
          </div>
        </div>
      </div>

      <div style={{ maxWidth: contentMaxWidth, margin: '0 auto', padding: '12px 20px 0' }}>
        {effectiveView === 'agenda'
          ? (
            <AgendaView
              events={events}
              loaded={loaded}
              headerHeight={headerHeight}
              isAdmin={isAdmin}
              focusEventId={focusEventId}
              onFocusHandled={clearFocus}
              onEdit={(e) => setEditingId(e.id)}
              onDelete={deleteEvent}
              onRestore={restoreEvent}
              billOptions={billOptions}
              editingId={editingId}
              onEditSave={async (v) => { await saveEvent(v) }}
              onEditCancel={() => setEditingId(null)}
            />
          )
          : (
            <MonthGrid
              events={events}
              initialYear={now.getFullYear()}
              initialMonth={now.getMonth()}
              onSelect={(e, anchor, alignRight) => selectEvent(e, anchor, alignRight)}
              onSelectDay={selectDay}
              onAddEvent={isAdmin ? openAddForDay : undefined}
              suppressHover={!!popover || !!dayPopover}
              activeDateIso={activeDateIso}
            />
          )}

        {popover && (
          <EventPopover
            key={popover.token}
            ref={popoverPanelRef}
            triggerRef={popoverTriggerRef}
            event={popover.event}
            position={popover.position}
            isAdmin={isAdmin}
            expandFrom={popover.expandFrom}
            computeTarget={popover.computeTarget}
            onEdit={(e) => {
              const el = popoverTriggerRef.current
              const alignRight = popover.alignRight
              setPopover(null)
              openEditForm(e, el, alignRight)
            }}
            onDelete={deleteEvent}
            onRestore={restoreEvent}
            onClose={() => setPopover((p) => (p && p.token === popover.token ? null : p))}
          />
        )}

        {dayPopover && (
          <DayPopover
            key={dayPopover.token}
            ref={dayPanelRef}
            triggerRef={dayTriggerRef}
            dateIso={dayPopover.dateIso}
            events={dayPopover.events}
            isAdmin={isAdmin}
            position={dayPopover.position}
            onEdit={(e) => {
              const el = dayTriggerRef.current
              const alignRight = dayPopover.alignRight
              setDayPopover(null)
              openEditForm(e, el, alignRight)
            }}
            onDelete={deleteEvent}
            onRestore={restoreEvent}
            onClose={() => setDayPopover((p) => (p && p.token === dayPopover.token ? null : p))}
          />
        )}

        {form && (
          <EventForm
            key={form.token}
            ref={formPanelRef}
            initial={form.initial}
            billOptions={billOptions}
            multiState={multiState}
            position={form.position}
            clampPosition={form.clampPosition}
            onSave={saveEvent}
            onClose={() => setForm((f) => (f && f.token === form.token ? null : f))}
          />
        )}
      </div>

      {importing && (
        <Suspense fallback={null}>
          <ImportEvents
            onClose={() => setImporting(false)}
            onImported={() => { loadEvents() }}
          />
        </Suspense>
      )}
    </>
  )
}
