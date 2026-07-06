import { todayIso } from './calendarGrid'

// Day-header strings shared by the agenda date dividers and the event popovers,
// rendered through <DateLabel> (uppercased, amber when today).

// "Thu, Jun 11"
export function formatDateHeader(iso: string): string {
  const d = new Date(`${iso}T00:00:00`)
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
}

// "TODAY, JUN 11"
export function formatTodayHeader(iso: string): string {
  const d = new Date(`${iso}T00:00:00`)
  return `TODAY, ${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }).toUpperCase()}`
}

// Label + isToday for an event's date, ready to spread into <DateLabel>.
export function eventDateLabel(iso: string): { label: string; isToday: boolean } {
  const isToday = iso === todayIso()
  return { label: isToday ? formatTodayHeader(iso) : formatDateHeader(iso), isToday }
}

// "Jun 9" — month + day, for compact date stamps (e.g. change-history tooltips).
// Accepts a date-only string or a full timestamp.
export function formatMonthDay(iso: string): string {
  const d = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? new Date(`${iso}T00:00:00`) : new Date(iso)
  if (isNaN(d.getTime())) return ''
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}
