import { color, fontSize, fontWeight, radius } from '../../../shared/tokens'
import { priorityMarkerSpec } from '../../../shared/priorityMarker'
import { PRIORITY_COLORS, CHIP_MINI_DIMS } from '../../../shared/billChipColors'
import { eventSourceIcon, eventBodyModel, EVENT_SOURCE_TILE, formatEventUrl } from '../../../shared/eventLineModel'
import { emailIconSrc } from '../../../shared/emailIcons'
import type { EventSource } from '../../../shared/eventSource'
import { renderEmailShell, emailButton, emailFooterLink, formatDateRange } from './emailShell'

interface WeekAheadBill {
  id: string
  billNumber: string
  state?: string | null
  priority?: 'high' | 'medium' | 'low' | null
  billTitle?: string | null
}

export interface WeekAheadEvent {
  id: string
  /** Canonical hearing identity (null for custom events) — preferred for the
   *  agenda deep-link, since hearings may be merged under a different id there. */
  eventHash?: string | null
  source: EventSource
  /** A date-field event's field name, the hover label of its marker. */
  fieldName?: string | null
  description?: string | null
  location?: string | null
  time?: string | null
  status?: string | null
  details?: string | null
  url?: string | null
  bills: WeekAheadBill[]
}

export interface WeekAheadDay {
  date: string
  label: string  // e.g. "Thursday, June 19"
  events: WeekAheadEvent[]
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// Trailing priority marker — the shared rounded-square marker (see
// shared/priorityMarker + the web PrioritySquare). Email clients strip SVG, so
// here we serialize the shared spec into a border-radius span; the geometry and
// halo come from the spec, so this never drifts from the web chip.
function renderPriorityMarker(priority: 'high' | 'medium' | 'low' | null | undefined): string {
  if (!priority) return ''
  const m = priorityMarkerSpec(priority, { size: 9, ring: true })
  // title gives a native hover tooltip ("High priority") in desktop mail clients.
  return `<span title="${escHtml(PRIORITY_COLORS[priority].label)}" style="display:inline-block;width:${m.size}px;height:${m.size}px;border-radius:${m.radius}px;background:${m.fill};box-shadow:${m.ring};margin-left:6px;vertical-align:middle;flex-shrink:0;"></span>`
}

function renderBillChip(bill: WeekAheadBill): string {
  const label = bill.state ? `${escHtml(bill.state)} ${escHtml(bill.billNumber)}` : escHtml(bill.billNumber)
  const marker = renderPriorityMarker(bill.priority)
  return `<span style="display:inline-flex;align-items:center;background:${color.billBadgeNavy};color:${color.white};font-size:${CHIP_MINI_DIMS.fontSize}px;font-weight:${fontWeight.bold};padding:${CHIP_MINI_DIMS.padding};border-radius:${CHIP_MINI_DIMS.radius}px;letter-spacing:0.02em;margin-right:4px;margin-bottom:3px;">${label}${marker}</span>`
}

// Small inline meta-line icon (clock / location / link), muted to match the web
// agenda card. PNGs are pre-rendered (icon font unavailable in email).
function metaIcon(icon: string, appUrl: string): string {
  return `<img src="${appUrl}/email-icons/${emailIconSrc(icon, color.textMuted)}" width="14" height="14" alt="" style="display:inline-block;vertical-align:-2px;margin-right:4px;border:0;">`
}

// ⚠️ Web twin: web/src/components/calendar/EventLines.tsx (full variant) is the
// agenda version of this card. Shared bits flow through eventSourceIcon/
// eventBodyModel/formatEventUrl/EVENT_SOURCE_TILE; this HTML layout is separate,
// so keep both in the same stacked order: title / time / location / link / chips
// / details.
function renderEventCard(event: WeekAheadEvent, appUrl: string): string {
  const { icon, color: iconColor, tint, label: sourceLabel } = eventSourceIcon(event)
  const { time, text, location } = eventBodyModel(event, false)
  const t = EVENT_SOURCE_TILE
  const sourceTile = `<span title="${escHtml(sourceLabel)}" style="flex-shrink:0;display:inline-flex;align-items:center;justify-content:center;width:${t.size}px;height:${t.size}px;border-radius:${t.radius}px;background:${tint};margin-top:1px;"><img src="${appUrl}/email-icons/${emailIconSrc(icon, iconColor)}" width="${t.glyphPx}" height="${t.glyphPx}" alt="${escHtml(sourceLabel)}" style="display:block;border:0;"></span>`

  const titleLine = text
    ? `<div style="font-size:${fontSize.sm}px;font-weight:${fontWeight.semibold};color:${color.textPrimary};">${escHtml(text)}</div>`
    : ''
  const timeLine = time
    ? `<div style="font-size:${fontSize.xs}px;color:${color.textMuted};margin-top:2px;">${metaIcon('schedule', appUrl)}${escHtml(time)}</div>`
    : ''
  const locationLine = location
    ? `<div style="font-size:${fontSize.xs}px;color:${color.textMuted};margin-top:2px;">${metaIcon('location_on', appUrl)}${escHtml(location)}</div>`
    : ''
  const linkLine = event.url
    ? `<div style="font-size:${fontSize.xs}px;margin-top:2px;">${metaIcon('link', appUrl)}<a href="${escHtml(event.url)}" style="color:${color.accentBlue};text-decoration:underline;overflow-wrap:anywhere;">${escHtml(formatEventUrl(event.url))}</a></div>`
    : ''
  const chips = event.bills.length > 0
    ? `<div style="display:flex;flex-wrap:wrap;margin-top:3px;">${event.bills.map(renderBillChip).join('')}</div>`
    : ''
  // The whole card links to the agenda, which scroll-and-flashes this event.
  // Prefer eventHash (hearings may be merged under a different id in the agenda);
  // fall back to the DB id for custom events. The agenda resolver matches either.
  const href = `${appUrl}/calendar?focusEvent=${encodeURIComponent(event.eventHash ?? event.id)}`
  const shownDetails = event.details ? truncateDetails(event.details) : null
  const detailsLine = shownDetails
    ? `<div style="font-size:${fontSize.xs}px;color:${color.textMuted};margin-top:4px;white-space:pre-line;line-height:1.5;">${escHtml(shownDetails.text)}${shownDetails.cut ? ` <a href="${escHtml(href)}" style="color:${color.accentBlue};text-decoration:underline;">Read more</a>` : ''}</div>`
    : ''
  return `<a href="${escHtml(href)}" style="text-decoration:none;color:inherit;display:block;">
  <div style="display:flex;align-items:flex-start;gap:8px;background:${color.white};border:1px solid ${color.borderDefault};border-radius:${radius.lg}px;box-shadow:0 1px 3px rgba(0,0,0,0.04);margin-bottom:8px;padding:10px 12px;">
  ${sourceTile}
  <div style="flex:1;min-width:0;">${titleLine}${timeLine}${locationLine}${linkLine}${chips}${detailsLine}</div>
</div></a>`
}

/** The longest `details` text a card shows. The calendar keeps the whole text (#774). */
export const WEEK_AHEAD_DETAILS_MAX_CHARS = 300

function truncateDetails(details: string): { text: string; cut: boolean } {
  if (details.length <= WEEK_AHEAD_DETAILS_MAX_CHARS) return { text: details, cut: false }
  let head = details.slice(0, WEEK_AHEAD_DETAILS_MAX_CHARS)
  if (/[\uD800-\uDBFF]$/.test(head)) head = head.slice(0, -1)  // not half of a surrogate pair
  const lastSpace = head.search(/\s\S*$/)
  return { text: `${(lastSpace > WEEK_AHEAD_DETAILS_MAX_CHARS / 2 ? head.slice(0, lastSpace) : head).trimEnd()}…`, cut: true }
}

/** The most body events (the legislature's own calendar) one email lists. A
 *  busy week would otherwise pass Gmail's ~102 KB clip, which hides the footer
 *  and the mute link (#675). */
export const WEEK_AHEAD_BODY_EVENT_CAP = 30

/**
 * Keep the email under the clip: at most `cap` body events, the earliest first.
 * A body event with a prioritized bill on its agenda is never cut and doesn't
 * count toward the cap. Custom, bill-entry, and date-field events are not cut
 * here (an instance adds few); fitToBudget bounds them by size. Returns the days still holding events, and how
 * many body events were left out.
 */
export function capBodyEvents(days: WeekAheadDay[], cap: number = WEEK_AHEAD_BODY_EVENT_CAP): { days: WeekAheadDay[]; omitted: number } {
  let counted = 0
  let omitted = 0
  const capped = days.map(day => ({
    ...day,
    events: day.events.filter(e => {
      if (e.source !== 'body' || e.bills.some(b => b.priority)) return true
      if (counted < cap) { counted++; return true }
      omitted++
      return false
    }),
  })).filter(day => day.events.length > 0)
  return { days: capped, omitted }
}

/** The size the email aims under, below Gmail's ~102 KB clip with room for the footer. */
export const WEEK_AHEAD_BYTE_BUDGET = 90 * 1024

/**
 * Keep the rendered email under `budget` bytes (#774). Events with a
 * prioritized bill (date-field events carry theirs) come first, each group
 * earliest first, and the email keeps the longest run of them that fits;
 * the rest are counted in `omitted`, added to the count already left out.
 */
export function fitToBudget(
  days: WeekAheadDay[],
  omitted: number,
  render: (days: WeekAheadDay[], omitted: number) => string,
  budget: number = WEEK_AHEAD_BYTE_BUDGET,
): { days: WeekAheadDay[]; omitted: number } {
  const bytes = (d: WeekAheadDay[], o: number) => new TextEncoder().encode(render(d, o)).length
  if (bytes(days, omitted) <= budget) return { days, omitted }
  const all = days.flatMap(d => d.events)
  const prioritized = (e: WeekAheadEvent) => e.bills.some(b => b.priority)
  const order = [...all.filter(prioritized), ...all.filter(e => !prioritized(e))]
  const rank = new Map(order.map((e, i) => [e, i]))
  const keep = (k: number) => {
    const kept = days
      .map(d => ({ ...d, events: d.events.filter(e => rank.get(e)! < k) }))
      .filter(d => d.events.length > 0)
    return { kept, omitted: omitted + all.length - k }
  }
  // The top event is always kept, so a day exists to label even when it alone is over budget.
  let lo = 1, hi = Math.max(all.length - 1, 1)  // all.length already failed
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    const c = keep(mid)
    if (bytes(c.kept, c.omitted) <= budget) lo = mid
    else hi = mid - 1
  }
  const c = keep(lo)
  return { days: c.kept, omitted: c.omitted }
}

function formatDateRangeLabel(days: WeekAheadDay[]): string {
  if (days.length === 0) return ''
  // Extract "June 15" from "Monday, June 15"
  const first = days[0].label.split(', ').slice(1).join(', ')
  const last = days[days.length - 1].label.split(', ').slice(1).join(', ')
  return formatDateRange(first, last)
}

export function renderWeekAheadEmail({
  days,
  assocName,
  appUrl,
  omitted = 0,
}: {
  days: WeekAheadDay[]
  assocName: string
  appUrl: string
  /** Body events left out by capBodyEvents, counted in a closing line that links to the calendar. */
  omitted?: number
}): string {
  const range = formatDateRangeLabel(days)
  const totalEvents = days.reduce((n, d) => n + d.events.length, 0) + omitted
  const dayBlocks = days.map(day => `
<h3 style="font-size:${fontSize.base}px;font-weight:${fontWeight.bold};color:${color.textPrimary};margin:16px 0 6px 0;padding-bottom:4px;border-bottom:1px solid ${color.borderDefault};">${escHtml(day.label)}</h3>
${day.events.map(e => renderEventCard(e, appUrl)).join('')}`).join('')
  const overflowHtml = omitted > 0
    ? `
<div style="font-size:${fontSize.sm}px;margin:8px 0 0 0;"><a href="${escHtml(appUrl)}/calendar" style="color:${color.accentBlue};text-decoration:underline;">and ${omitted} more on the calendar</a></div>`
    : ''

  return renderEmailShell({
    instanceName: assocName,
    appUrl,
    signalHtml: `${totalEvents} ${totalEvents === 1 ? 'event' : 'events'} in the week ahead`,
    dateLabel: range,
    bodyHtml: dayBlocks + overflowHtml,
    ctaHtml: emailButton(`${escHtml(appUrl)}/calendar`, 'View calendar'),
    footerHtml: `${emailFooterLink(`${escHtml(appUrl)}/calendar#subscribe`, 'Subscribe to your calendar')} &nbsp;·&nbsp; ${emailFooterLink(`${escHtml(appUrl)}/profile#setting-week-ahead`, 'Manage email settings')}`,
  })
}
