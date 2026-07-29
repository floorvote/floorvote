import { color, fontSize, fontWeight, radius } from '../../../shared/tokens'
import { priorityMarkerSpec } from '../../../shared/priorityMarker'
import { PRIORITY_COLORS, CHIP_MINI_DIMS } from '../../../shared/billChipColors'
import { eventSourceIcon, eventBodyModel, EVENT_SOURCE_TILE, formatEventUrl } from '../../../shared/eventLineModel'
import { emailIconSrc } from '../../../shared/emailIcons'
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
  source: string
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
    ? `<div style="font-size:${fontSize.xs}px;margin-top:2px;">${metaIcon('link_2', appUrl)}<a href="${escHtml(event.url)}" style="color:${color.accentBlue};text-decoration:underline;overflow-wrap:anywhere;">${escHtml(formatEventUrl(event.url))}</a></div>`
    : ''
  const chips = event.bills.length > 0
    ? `<div style="display:flex;flex-wrap:wrap;margin-top:3px;">${event.bills.map(renderBillChip).join('')}</div>`
    : ''
  const detailsLine = event.details
    ? `<div style="font-size:${fontSize.xs}px;color:${color.textMuted};margin-top:4px;white-space:pre-line;line-height:1.5;">${escHtml(event.details)}</div>`
    : ''

  // The whole card links to the agenda, which scroll-and-flashes this event.
  // Prefer eventHash (hearings may be merged under a different id in the agenda);
  // fall back to the DB id for custom events. The agenda resolver matches either.
  const href = `${appUrl}/calendar?focusEvent=${encodeURIComponent(event.eventHash ?? event.id)}`
  return `<a href="${escHtml(href)}" style="text-decoration:none;color:inherit;display:block;">
  <div style="display:flex;align-items:flex-start;gap:8px;background:${color.white};border:1px solid ${color.borderDefault};border-radius:${radius.lg}px;box-shadow:0 1px 3px rgba(0,0,0,0.04);margin-bottom:8px;padding:10px 12px;">
  ${sourceTile}
  <div style="flex:1;min-width:0;">${titleLine}${timeLine}${locationLine}${linkLine}${chips}${detailsLine}</div>
</div></a>`
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
  icsUrl,
}: {
  days: WeekAheadDay[]
  assocName: string
  appUrl: string
  icsUrl: string
}): string {
  const range = formatDateRangeLabel(days)
  const totalEvents = days.reduce((n, d) => n + d.events.length, 0)
  const dayBlocks = days.map(day => `
<h3 style="font-size:${fontSize.base}px;font-weight:${fontWeight.bold};color:${color.textPrimary};margin:16px 0 6px 0;padding-bottom:4px;border-bottom:1px solid ${color.borderDefault};">${escHtml(day.label)}</h3>
${day.events.map(e => renderEventCard(e, appUrl)).join('')}`).join('')

  return renderEmailShell({
    instanceName: assocName,
    appUrl,
    signalHtml: `${totalEvents} ${totalEvents === 1 ? 'event' : 'events'} in the week ahead`,
    dateLabel: range,
    bodyHtml: dayBlocks,
    ctaHtml: emailButton(`${escHtml(appUrl)}/calendar`, 'View calendar'),
    footerHtml: `${emailFooterLink(escHtml(icsUrl), 'Subscribe to your calendar')} &nbsp;·&nbsp; ${emailFooterLink(`${escHtml(appUrl)}/profile#setting-week-ahead`, 'Manage email settings')}`,
  })
}
