// RFC-5545 (iCalendar) builders. Pure, dependency-free, no I/O.
//
// Timed events are anchored to the event's state timezone (TZID + VTIMEZONE)
// rather than emitted as floating local time. Floating works in some clients
// (Apple) but Google Calendar interprets floating times in a subscribed feed
// as UTC, shifting every event by the viewer's offset (e.g. 4h for US Eastern).
// Anchoring to the state's IANA zone makes clients show the correct wall-clock
// time for that state. All-day events stay date-only (no zone needed).

import { PRODUCT_NAME } from '../../../shared/brand'

export type IcalEvent = {
  uid: string
  sequence: number
  status: 'confirmed' | 'cancelled'
  date: string | null          // 'YYYY-MM-DD'
  time: string | null          // 'HH:MM' or 'HH:MM:SS' — null or all-zero → all-day
  location: string | null
  summary: string
  description?: string | null
  url?: string | null
  /** IANA zone for the timed value (e.g. 'America/New_York'). null → floating. */
  tzid?: string | null
}

// --- Timezone support -------------------------------------------------------

// US state (+ DC) → IANA zone. Several states span two zones, so we map each to
// its CAPITOL's zone — hearings happen at the statehouse, so the capitol zone is
// the correct one (FL/IN/KY/MI → Eastern; KS/NE/ND/SD/TN/TX → Central;
// OR → Pacific; ID → Mountain).
const STATE_TZ: Record<string, string> = {
  AL: 'America/Chicago', AK: 'America/Anchorage', AZ: 'America/Phoenix', AR: 'America/Chicago',
  CA: 'America/Los_Angeles', CO: 'America/Denver', CT: 'America/New_York', DE: 'America/New_York',
  DC: 'America/New_York', FL: 'America/New_York', GA: 'America/New_York', HI: 'Pacific/Honolulu',
  ID: 'America/Denver', IL: 'America/Chicago', IN: 'America/New_York', IA: 'America/Chicago',
  KS: 'America/Chicago', KY: 'America/New_York', LA: 'America/Chicago', ME: 'America/New_York',
  MD: 'America/New_York', MA: 'America/New_York', MI: 'America/New_York', MN: 'America/Chicago',
  MS: 'America/Chicago', MO: 'America/Chicago', MT: 'America/Denver', NE: 'America/Chicago',
  NV: 'America/Los_Angeles', NH: 'America/New_York', NJ: 'America/New_York', NM: 'America/Denver',
  NY: 'America/New_York', NC: 'America/New_York', ND: 'America/Chicago', OH: 'America/New_York',
  OK: 'America/Chicago', OR: 'America/Los_Angeles', PA: 'America/New_York', RI: 'America/New_York',
  SC: 'America/New_York', SD: 'America/Chicago', TN: 'America/Chicago', TX: 'America/Chicago',
  UT: 'America/Denver', VT: 'America/New_York', VA: 'America/New_York', WA: 'America/Los_Angeles',
  WV: 'America/New_York', WI: 'America/Chicago', WY: 'America/Denver',
}

// Map a two-letter state code to its IANA zone, or null when unknown/empty
// (the event then falls back to floating).
export function tzidForState(state: string | null | undefined): string | null {
  if (!state) return null
  return STATE_TZ[state.trim().toUpperCase()] ?? null
}

// Standard VTIMEZONE definitions for the US zones referenced above. Post-2007
// US DST rules (2nd Sun Mar → 1st Sun Nov); Phoenix and Honolulu observe no DST.
const VTIMEZONE_DEFS: Record<string, string[]> = {
  'America/New_York': dstZone('America/New_York', '-0500', '-0400', 'EST', 'EDT'),
  'America/Chicago': dstZone('America/Chicago', '-0600', '-0500', 'CST', 'CDT'),
  'America/Denver': dstZone('America/Denver', '-0700', '-0600', 'MST', 'MDT'),
  'America/Los_Angeles': dstZone('America/Los_Angeles', '-0800', '-0700', 'PST', 'PDT'),
  'America/Anchorage': dstZone('America/Anchorage', '-0900', '-0800', 'AKST', 'AKDT'),
  'America/Phoenix': fixedZone('America/Phoenix', '-0700', 'MST'),
  'Pacific/Honolulu': fixedZone('Pacific/Honolulu', '-1000', 'HST'),
}

function dstZone(tzid: string, stdOff: string, dstOff: string, stdName: string, dstName: string): string[] {
  return [
    'BEGIN:VTIMEZONE', `TZID:${tzid}`,
    'BEGIN:DAYLIGHT', `TZOFFSETFROM:${stdOff}`, `TZOFFSETTO:${dstOff}`, `TZNAME:${dstName}`,
    'DTSTART:19700308T020000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU', 'END:DAYLIGHT',
    'BEGIN:STANDARD', `TZOFFSETFROM:${dstOff}`, `TZOFFSETTO:${stdOff}`, `TZNAME:${stdName}`,
    'DTSTART:19701101T020000', 'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU', 'END:STANDARD',
    'END:VTIMEZONE',
  ]
}

function fixedZone(tzid: string, off: string, name: string): string[] {
  return [
    'BEGIN:VTIMEZONE', `TZID:${tzid}`,
    'BEGIN:STANDARD', `TZOFFSETFROM:${off}`, `TZOFFSETTO:${off}`, `TZNAME:${name}`,
    'DTSTART:19700101T000000', 'END:STANDARD',
    'END:VTIMEZONE',
  ]
}

export type VCalendarMeta = {
  calName: string
  now: string                  // ISO timestamp used for DTSTAMP
}

// Escape per RFC 5545 §3.3.11: backslash FIRST (so added escapes aren't re-escaped),
// then semicolon, comma, and newlines.
function esc(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n')
}

function isAllDay(time: string | null): boolean {
  if (!time) return true
  // All-zero time (any format: '0:0', '00:00', '00:00:00') means "no time given" → all-day.
  return /^[0:]+$/.test(time)
}

function dateValue(date: string): string {
  return date.replace(/-/g, '')
}

// 'HH:MM' or 'HH:MM:SS' → 'HHMMSS' (always 6 digits, zero-padded).
function formatTime(time: string): string {
  const [h = '00', m = '00', s = '00'] = time.split(':')
  return `${h.padStart(2, '0')}${m.padStart(2, '0')}${s.padStart(2, '0')}`
}

function dateTimeValue(date: string, time: string): string {
  return `${dateValue(date)}T${formatTime(time)}`
}

// LegiScan gives no end time, so timed hearings default to a 1-hour block.
// Floating local time — arithmetic done in UTC purely to handle midnight rollover.
function plusOneHour(date: string, time: string): { date: string; time: string } {
  const [y, mo, d] = date.split('-').map(Number)
  const [h = 0, mi = 0, s = 0] = time.split(':').map(Number)
  const dt = new Date(Date.UTC(y, mo - 1, d, h + 1, mi, s))
  const iso = dt.toISOString()
  return { date: iso.slice(0, 10), time: iso.slice(11, 19) }
}

function stampValue(iso: string): string {
  return new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
}

// 'YYYYMMDDTHHMMSSZ' for a UTC instant.
function utcStamp(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
}

// Offset (ms) of `zone` at a given instant: (wall-clock-in-zone as if UTC) − instant.
function tzOffsetMs(zone: string, instant: number): number | null {
  try {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: zone, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    })
    const parts = dtf.formatToParts(new Date(instant))
    const get = (t: string) => Number(parts.find(p => p.type === t)?.value)
    let hour = get('hour'); if (hour === 24) hour = 0 // some engines emit hour 24 for midnight
    const wallAsUtc = Date.UTC(get('year'), get('month') - 1, get('day'), hour, get('minute'), get('second'))
    return wallAsUtc - instant
  } catch {
    return null // unknown zone / no Intl tz data
  }
}

// Convert a floating wall-clock time in `zone` to the absolute UTC instant.
// Used for stored creator zones outside the 7 zones we ship VTIMEZONE blocks
// for — emitting a UTC DTSTART is unambiguous in every client, no VTIMEZONE.
function zonedWallTimeToUtc(date: string, time: string, zone: string): Date | null {
  const [y, mo, d] = date.split('-').map(Number)
  const [h = 0, mi = 0, s = 0] = time.split(':').map(Number)
  const wallAsUtc = Date.UTC(y, mo - 1, d, h, mi, s)
  const off1 = tzOffsetMs(zone, wallAsUtc)
  if (off1 === null) return null
  // Offset can differ at the corrected instant (near a DST boundary); refine once.
  let instant = wallAsUtc - off1
  const off2 = tzOffsetMs(zone, instant)
  if (off2 !== null && off2 !== off1) instant = wallAsUtc - off2
  return new Date(instant)
}

// RFC 5545 §3.1: content lines longer than 75 octets must be folded — split with
// CRLF followed by a single space. Octet-aware (UTF-8) and never splits a code point.
function foldLine(line: string): string {
  const enc = new TextEncoder()
  let out = ''
  let lineBytes = 0
  for (const ch of Array.from(line)) {        // Array.from → iterate code points, not surrogate halves
    const chBytes = enc.encode(ch).length
    if (lineBytes + chBytes > 75) {
      out += '\r\n '                            // fold marker; leading space is part of the next physical line
      lineBytes = 1                             // count the leading space
    }
    out += ch
    lineBytes += chBytes
  }
  return out
}

// --- Injection guards -------------------------------------------------------
// `date` and `time` are interpolated RAW into DTSTART/DTEND (not via esc()), so a
// CR/LF in either would break out of the content line and inject arbitrary
// VCALENDAR lines into the public, unauthenticated feed. The hearing path stores
// LegiScan's values unvalidated, so enforce shape here at the sink — this guards
// every path (hearing, custom, import) at once. A malformed date drops DTSTART;
// a malformed time degrades the event to all-day. The strict patterns (digits +
// separators only) make any CR/LF or smuggled text fail the match.
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const TIME_RE = /^\d{1,2}:\d{1,2}(:\d{1,2})?$/
const validDate = (d: string | null): string | null => (d && DATE_RE.test(d) ? d : null)
const validTime = (t: string | null): string | null => (t && TIME_RE.test(t) ? t : null)
// Belt-and-suspenders for the one remaining raw-interpolated string field (UID,
// server-generated today but guarded so no future caller can inject via it).
const noCrlf = (v: string): string => v.replace(/[\r\n]+/g, '')

export function buildVEvent(e: IcalEvent, now: string): string {
  const date = validDate(e.date)
  const time = validTime(e.time)
  const lines: string[] = ['BEGIN:VEVENT', `UID:${noCrlf(e.uid)}`, `DTSTAMP:${stampValue(now)}`, `SEQUENCE:${e.sequence}`]

  if (date) {
    if (isAllDay(time)) {
      lines.push(`DTSTART;VALUE=DATE:${dateValue(date)}`)
    } else {
      const t = time as string
      if (e.tzid && VTIMEZONE_DEFS[e.tzid]) {
        // Known zone → reference its VTIMEZONE by TZID.
        lines.push(`DTSTART;TZID=${e.tzid}:${dateTimeValue(date, t)}`)
        const end = plusOneHour(date, t)
        lines.push(`DTEND;TZID=${e.tzid}:${dateTimeValue(end.date, end.time)}`)
      } else if (e.tzid && zonedWallTimeToUtc(date, t, e.tzid)) {
        // Arbitrary zone (e.g. a creator's browser zone) → emit a UTC instant.
        const start = zonedWallTimeToUtc(date, t, e.tzid) as Date
        lines.push(`DTSTART:${utcStamp(start)}`)
        lines.push(`DTEND:${utcStamp(new Date(start.getTime() + 3600_000))}`)
      } else {
        // No zone (or conversion failed) → floating local time.
        lines.push(`DTSTART:${dateTimeValue(date, t)}`)
        const end = plusOneHour(date, t)
        lines.push(`DTEND:${dateTimeValue(end.date, end.time)}`)
      }
    }
  }

  lines.push(`SUMMARY:${esc(e.summary)}`)
  if (e.location) lines.push(`LOCATION:${esc(e.location)}`)
  if (e.description) lines.push(`DESCRIPTION:${esc(e.description)}`)
  if (e.url) lines.push(`URL:${esc(e.url)}`)
  lines.push(`STATUS:${e.status === 'cancelled' ? 'CANCELLED' : 'CONFIRMED'}`)
  lines.push('END:VEVENT')
  return lines.map(foldLine).join('\r\n')
}

export function buildVCalendar(events: IcalEvent[], meta: VCalendarMeta): string {
  const head = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:-//${PRODUCT_NAME}//Hearing Calendar//EN`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${esc(meta.calName)}`,
    'X-PUBLISHED-TTL:PT12H',
    'REFRESH-INTERVAL;VALUE=DURATION:PT12H',
  ]
  // Emit a VTIMEZONE for each zone referenced by a timed event, before the events.
  const usedZones = new Set<string>()
  for (const e of events) {
    // Mirror buildVEvent's validation so we only emit a VTIMEZONE for an event
    // that will actually produce a TZID-referencing timed DTSTART.
    if (e.tzid && validDate(e.date) && !isAllDay(validTime(e.time)) && VTIMEZONE_DEFS[e.tzid]) usedZones.add(e.tzid)
  }
  const vtimezones = [...usedZones].sort().flatMap(tz => VTIMEZONE_DEFS[tz].map(foldLine))

  const body = events.map(e => buildVEvent(e, meta.now))   // already folded internally
  return [...head.map(foldLine), ...vtimezones, ...body, 'END:VCALENDAR'].join('\r\n') + '\r\n'
}
