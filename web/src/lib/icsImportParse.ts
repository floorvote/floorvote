import ICAL from 'ical.js'
import type { ImportRowPreview } from './calendarImportParse'

/** Expansion horizon for a recurring series, and a hard stop for unbounded rules. */
const HORIZON_MONTHS = 12
const MAX_OCCURRENCES = 200

/** True when the text is an iCalendar document, sniffed by content rather than extension. */
export function isIcs(text: string): boolean {
  return /^﻿?\s*BEGIN:VCALENDAR/i.test(text)
}

/**
 * Outlook writes Windows zone names ("Central Standard Time"), not IANA ones. They must be
 * translated: the server's sanitizeTimezone requires an Area/City shape, so an untranslated
 * Windows name is silently dropped and the outbound feed loses the event's anchor.
 *
 * US zones only — an unmapped name falls through to the caller's fallback zone, which is the
 * same behaviour as a DTSTART carrying no zone at all.
 */
const WINDOWS_TZ: Record<string, string> = {
  'eastern standard time': 'America/New_York',
  'central standard time': 'America/Chicago',
  'mountain standard time': 'America/Denver',
  'us mountain standard time': 'America/Phoenix',   // Arizona, no DST
  'pacific standard time': 'America/Los_Angeles',
  'alaskan standard time': 'America/Anchorage',
  'hawaiian standard time': 'Pacific/Honolulu',
  'utc': 'UTC',
}

/** An IANA zone already contains a slash; anything else may be a Windows name. */
function toIana(tzid: string): string | null {
  if (tzid.includes('/')) return tzid
  return WINDOWS_TZ[tzid.trim().toLowerCase()] ?? null
}

const pad = (n: number) => String(n).padStart(2, '0')

/** Render a UTC instant as wall-clock date + time in `tz`. Used only for a zoneless UTC DTSTART. */
function toWallClock(utc: Date, tz: string): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(utc)
  const g = (t: string) => parts.find(p => p.type === t)?.value ?? '00'
  return { date: `${g('year')}-${g('month')}-${g('day')}`, time: `${g('hour')}:${g('minute')}` }
}

interface Resolved { dateIso: string; time: string | null; timezone: string | null }

/**
 * An ICAL.Time to our storage shape.
 *
 * All-day (`isDate`) keeps no time at all — it must never become midnight, which is what
 * makes the outbound feed emit DTSTART;VALUE=DATE (api/src/lib/ical.ts:215).
 *
 * A timed value is stored as verbatim wall clock per docs/internal/dates.md; conversion
 * happens here at the import boundary and never again at read time.
 */
function resolveTime(t: ICAL.Time, fallbackTz: string): Resolved {
  const ymd = `${t.year}-${pad(t.month)}-${pad(t.day)}`
  if (t.isDate) return { dateIso: ymd, time: null, timezone: null }

  const tzid = t.zone?.tzid ?? null
  // A zoneless timed DTSTART reports tzid 'floating' (verified against ical.js 2.2.1) — it is
  // already wall clock, so keep it verbatim and record no zone. Storing the literal string
  // 'floating' would be meaningless downstream (the server's sanitizeTimezone drops it anyway).
  if (tzid === 'floating' || !tzid) {
    return { dateIso: ymd, time: `${pad(t.hour)}:${pad(t.minute)}`, timezone: null }
  }
  if (tzid === 'UTC' || tzid === 'Z') {
    // A true UTC instant, so it says nothing about where the event happens. Resolve it against
    // the caller's zone — the tenant's own jurisdiction where known, not the admin's browser.
    const { date, time } = toWallClock(t.toJSDate(), fallbackTz)
    return { dateIso: date, time, timezone: fallbackTz }
  }
  // Wall clock is already correct whatever the zone is named; only the recorded zone needs
  // translating. An unrecognised name is dropped rather than stored in a form the server rejects.
  return { dateIso: ymd, time: `${pad(t.hour)}:${pad(t.minute)}`, timezone: toIana(tzid) }
}

/**
 * Parse an iCalendar document into preview rows for the existing importer.
 *
 * `fallbackTz` resolves a UTC DTSTART carrying no zone — pass the admin's browser zone.
 * Only VEVENT is read. A recurring series expands over HORIZON_MONTHS, capped at
 * MAX_OCCURRENCES, with each occurrence given its own uid so the server-side upsert
 * treats them as distinct events rather than collapsing them into one.
 */
export function parseIcs(text: string, fallbackTz: string): ImportRowPreview[] {
  const comp = new ICAL.Component(ICAL.parse(text))
  // Register the file's own zone definitions so TZID resolves against them.
  for (const vt of comp.getAllSubcomponents('vtimezone')) {
    const tzid = vt.getFirstPropertyValue('tzid') as string | null
    if (tzid && !ICAL.TimezoneService.has(tzid)) {
      // register(timezone) — NOT register(name, timezone). The upstream wiki example has the
      // arguments the other way round; the shipped types and runtime both take the zone first.
      // TimezoneService is a module-level singleton, so a zone registered by one import
      // persists for later ones; the has() guard makes first-definition-wins explicit.
      ICAL.TimezoneService.register(new ICAL.Timezone({ component: vt, tzid }))
    }
  }

  const rows: ImportRowPreview[] = []
  for (const vevent of comp.getAllSubcomponents('vevent')) {
    rows.push(...expand(new ICAL.Event(vevent), fallbackTz))
  }
  return rows
}

function expand(event: ICAL.Event, fallbackTz: string): ImportRowPreview[] {
  const uid = (event.uid ?? '').trim()
  const title = (event.summary ?? '').trim()
  const base = {
    title,
    details: (event.description ?? '').trim() || null,
    location: (event.location ?? '').trim() || null,
    // ICAL.Event has no `url` accessor — read the property off the component.
    url: ((event.component.getFirstPropertyValue('url') as string | null) ?? '').trim() || null,
    raw: {},
  }
  const bad = (reason: string): ImportRowPreview[] => [{
    status: 'skip', reason, dateIso: null, time: null, timezone: null, uid: uid || undefined, ...base,
  }]

  // RFC 5545 requires UID. Without one there is nothing stable to match on re-upload,
  // so skip rather than silently falling back to a date+title hash.
  if (!uid) return bad('event has no UID')
  if (!title) return bad('add a title to include')
  if (!event.startDate) return bad('event has no start date')

  if (!event.isRecurring()) {
    return [{ status: 'ok', uid, ...resolveTime(event.startDate, fallbackTz), ...base }]
  }

  const horizon = event.startDate.clone()
  horizon.month += HORIZON_MONTHS
  const it = event.iterator()
  const out: ImportRowPreview[] = []
  let capped = false
  for (let next = it.next(); next; next = it.next()) {
    if (next.compare(horizon) > 0 || out.length >= MAX_OCCURRENCES) { capped = true; break }
    const r = resolveTime(next, fallbackTz)
    // Each occurrence needs a distinct uid; the server upserts on it, so a shared uid
    // would make every later occurrence overwrite the first.
    out.push({ status: 'ok', uid: `${uid}-${r.dateIso}`, ...r, ...base })
  }
  const notice = capped
    ? `recurring — capped at ${out.length} occurrences within ${HORIZON_MONTHS} months`
    : `recurring — ${out.length} occurrences imported`
  return out.map(r => ({ ...r, notice }))
}
