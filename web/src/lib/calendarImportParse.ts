export type RawRow = Record<string, unknown>

const KNOWN: Record<string, string[]> = {
  title: ['title', 'task', 'event', 'statutorily required tasks'],
  beginDate: ['begin date', 'date', 'start date'],
  endDate: ['end date'],
  time: ['time'],
  location: ['location'],
  details: ['details', 'description', 'notes'],
  url: ['url', 'link'],
}
const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ')

export interface HeaderMap {
  title: string | null; beginDate: string | null; endDate: string | null
  time: string | null; location: string | null; details: string | null; url: string | null; extras: string[]
}

export function matchHeaders(headers: string[]): HeaderMap {
  const used = new Set<string>()
  const pick = (keys: string[]) => {
    for (const h of headers) if (!used.has(h) && keys.includes(norm(h))) { used.add(h); return h }
    return null
  }
  const map: HeaderMap = {
    title: pick(KNOWN.title), beginDate: pick(KNOWN.beginDate), endDate: pick(KNOWN.endDate),
    time: pick(KNOWN.time), location: pick(KNOWN.location), details: pick(KNOWN.details),
    url: pick(KNOWN.url), extras: [],
  }
  map.extras = headers.filter(h => !used.has(h))
  return map
}

export type DateResult = { ok: true; iso: string } | { ok: false; raw?: string }

const pad = (n: number) => String(n).padStart(2, '0')

export function parseDate(value: unknown): DateResult {
  if (value instanceof Date && !isNaN(value.getTime())) {
    return { ok: true, iso: `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}` }
  }
  const s = String(value ?? '').trim()
  if (s === '') return { ok: false }
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return { ok: true, iso: s }
  // Accept M/D/YYYY and the two-digit M/D/YY that Excel writes when it re-saves a CSV.
  // A bare YY is mapped to 20YY — these are election/legislative calendars, always current-or-future,
  // so the century is unambiguous in practice. A 3-digit year stays a typo (neither branch matches).
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/)
  if (m) {
    const mm = +m[1], dd = +m[2]
    const yyyy = m[3].length === 2 ? 2000 + +m[3] : m[3]
    if (mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31) {
      return { ok: true, iso: `${yyyy}-${pad(mm)}-${pad(dd)}` }
    }
    return { ok: false, raw: s }
  }
  return { ok: false, raw: s }
}

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
const human = (iso: string) => { const [, m, d] = iso.split('-').map(Number); return `${MONTHS[m - 1]} ${d}` }

export function assembleDetails(p: { detailsText?: string; beginIso: string; endIso: string | null; extras: Record<string, string> }): string {
  const lines: string[] = []
  if (p.detailsText?.trim()) lines.push(p.detailsText.trim())
  if (p.endIso && p.endIso !== p.beginIso) lines.push(`Through ${human(p.endIso)}`)
  for (const [k, v] of Object.entries(p.extras)) if (String(v).trim()) lines.push(`${k}: ${String(v).trim()}`)
  return lines.join('\n')
}

export interface ImportRowPreview {
  status: 'ok' | 'warning' | 'skip'
  reason?: string
  title: string; dateIso: string | null; rawDate?: string
  details: string | null; time: string | null; location: string | null; url: string | null
  raw: RawRow
  /** ICS only: the VEVENT UID (suffixed per occurrence for a series). CSV rows derive one instead. */
  uid?: string
  /** ICS only: IANA zone for a timed event. CSV rows are date-only and leave this null. */
  timezone?: string | null
  /** Advisory text shown next to the status badge. Unlike `status`, it does NOT affect importability. */
  notice?: string
}

export function rowToImport(raw: RawRow, map: HeaderMap): ImportRowPreview {
  const title = String(raw[map.title ?? ''] ?? '').trim()
  const begin = parseDate(map.beginDate ? raw[map.beginDate] : '')
  const end: DateResult = map.endDate ? parseDate(raw[map.endDate]) : { ok: false }
  const extras: Record<string, string> = {}
  for (const h of map.extras) { const v = String(raw[h] ?? '').trim(); if (v) extras[h] = v }
  const detailsText = map.details ? String(raw[map.details] ?? '').trim() : ''
  const details = begin.ok ? assembleDetails({ detailsText, beginIso: begin.iso, endIso: end.ok ? end.iso : null, extras }) : ''
  const base = {
    title,
    details: details || null,
    time: map.time ? (String(raw[map.time] ?? '').trim() || null) : null,
    location: map.location ? (String(raw[map.location] ?? '').trim() || null) : null,
    url: map.url ? (String(raw[map.url] ?? '').trim() || null) : null,
    raw,
  }
  if (!title) return { status: 'skip', reason: 'missing title', dateIso: null, ...base }
  if (!begin.ok && begin.raw) return { status: 'warning', reason: `unrecognized date "${begin.raw}"`, dateIso: null, rawDate: begin.raw, ...base }
  if (!begin.ok) return { status: 'skip', reason: 'no date', dateIso: null, ...base }
  return { status: 'ok', dateIso: begin.iso, ...base }
}
