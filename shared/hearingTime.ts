export function formatHearingTime(time: string | null): string | null {
  if (!time) return null
  const m = time.match(/^(\d{1,2}):(\d{2})/)
  if (!m) return null
  let h = parseInt(m[1], 10)
  const min = m[2]
  if (h === 0 && min === '00') return null
  const ampm = h >= 12 ? 'PM' : 'AM'
  h = h % 12
  if (h === 0) h = 12
  return `${h}:${min} ${ampm}`
}

// Compact form for tight calendar UI (Google month-view style): lowercase
// meridiem letter, minutes dropped on the hour — "9a", "1:30p", "12p".
export function formatHearingTimeShort(time: string | null): string | null {
  if (!time) return null
  const m = time.match(/^(\d{1,2}):(\d{2})/)
  if (!m) return null
  let h = parseInt(m[1], 10)
  const min = parseInt(m[2], 10)
  if (h === 0 && min === 0) return null
  const mer = h >= 12 ? 'p' : 'a'
  h = h % 12
  if (h === 0) h = 12
  return min === 0 ? `${h}${mer}` : `${h}:${String(min).padStart(2, '0')}${mer}`
}
