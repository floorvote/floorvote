/**
 * Placeholder date/time filters for bill documents and calendar events.
 * LegiScan uses '0000-00-00' for documents without a date, and '00:00' for events without a time.
 * These helpers return null to hide those placeholders from the UI.
 */

export function safeDate(date: string | null | undefined): string | null {
  if (!date || date === '0000-00-00') return null
  return date
}

export function safeTime(time: string | null | undefined): string | null {
  if (!time || time === '00:00' || time === '00:00:00') return null
  return time
}
