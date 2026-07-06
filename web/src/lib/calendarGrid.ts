import { epochToLocalDay } from '../../../shared/time'

export interface CalendarEventBill {
  id: string
  billNumber: string
  billTitle: string
  state: string | null
  priority: 'high' | 'medium' | 'low' | null
}

export interface CalendarEvent {
  id: string
  uid: string
  source: string // 'hearing' | 'custom'
  /** Canonical hearing identity (null for custom events); used for deep-link focus. */
  eventHash?: string | null
  /** Every event_hash merged into this entry; the sidebar deep-link focus matches any of them. */
  eventHashes?: string[]
  billId: string | null
  bills: CalendarEventBill[]
  date: string | null // YYYY-MM-DD
  time: string | null  // HH:MM[:SS] or null/00:00 = all-day
  location: string | null
  description: string | null
  details: string | null
  url: string | null
  status: 'confirmed' | 'cancelled'
}

export interface DayCell {
  iso: string       // YYYY-MM-DD
  day: number       // day-of-month
  inMonth: boolean  // belongs to the displayed month
}

const pad = (n: number) => String(n).padStart(2, '0')
const toIso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

/** 6×7 matrix of weeks (Sunday-first) covering the given month. `month` is 0-indexed. */
export function buildMonthMatrix(year: number, month: number): DayCell[][] {
  const first = new Date(year, month, 1)
  const start = new Date(first)
  start.setDate(1 - first.getDay()) // back up to the Sunday on/just before the 1st
  const weeks: DayCell[][] = []
  const cursor = new Date(start)
  // Always render exactly 6 weeks — simple and always covers the whole month.
  for (let w = 0; w < 6; w++) {
    const week: DayCell[] = []
    for (let i = 0; i < 7; i++) {
      week.push({ iso: toIso(cursor), day: cursor.getDate(), inMonth: cursor.getMonth() === month })
      cursor.setDate(cursor.getDate() + 1)
    }
    weeks.push(week)
  }
  return weeks
}

// Minutes-since-midnight for a canonical HH:MM[:SS] time, or -1 for an all-day
// (null / 00:00 / unparseable) event so timeless events sort to the top of a day.
function timeSortKey(time: string | null): number {
  if (!time) return -1
  const m = time.match(/^(\d{1,2}):(\d{2})/)
  if (!m) return -1
  const mins = parseInt(m[1], 10) * 60 + parseInt(m[2], 10)
  return mins === 0 ? -1 : mins
}

export function bucketEventsByDate(events: CalendarEvent[]): Map<string, CalendarEvent[]> {
  const map = new Map<string, CalendarEvent[]>()
  for (const ev of events) {
    if (!ev.date) continue
    const list = map.get(ev.date) ?? []
    list.push(ev)
    map.set(ev.date, list)
  }
  // Order each day chronologically (all-day events first) so the month cells and
  // the day popover read top-to-bottom by time.
  for (const list of map.values()) {
    list.sort((a, b) => timeSortKey(a.time) - timeSortKey(b.time))
  }
  return map
}

// Today's date as YYYY-MM-DD in the VIEWER'S LOCAL calendar day — not UTC.
// `new Date().toISOString().slice(0,10)` is UTC, which rolls over to tomorrow in
// the evening for viewers west of UTC (e.g. 8:30pm ET = 00:30 UTC next day),
// making the agenda label tomorrow "TODAY". Calendar/hearing dates are floating
// local wall-clock values (see docs/date-format-convention.md §2), so they must
// be compared against the local day. Mirrors the Feed fix (581a35f3).
export const todayIso = () => epochToLocalDay(Date.now())
export const isPastDate = (iso: string, today: string = todayIso()) => iso < today
