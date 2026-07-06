// DB timestamps come in two UTC shapes: SQLite space format
// ("YYYY-MM-DD HH:MM:SS", produced by datetime('now')) and ISO-8601
// ("...T...Z", produced by Date.toISOString()). Normalize to a comparable
// epoch so a raw string compare (where " " (0x20) < "T" (0x54)) doesn't
// mis-order same-day rows. V8 parses the space format as LOCAL time, so we
// must convert to explicit-UTC ISO before Date.parse.
export function dbTsToEpoch(ts: string): number {
  const iso = ts.includes('T') ? ts : ts.replace(' ', 'T') + 'Z'
  return Date.parse(iso)
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

// Local calendar day ("YYYY-MM-DD") for an epoch-ms value, in the viewer's
// timezone. Day-bucketing and "Today"/"Yesterday" labels must read in local
// time: slicing the UTC string instead buckets a 7pm-EDT event into the next
// UTC day, so it wrongly shows as "Yesterday" to evening users west of UTC.
export function epochToLocalDay(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

// Local calendar day for a DB instant timestamp (routes through dbTsToEpoch so
// both UTC shapes parse correctly before the local-day projection).
export function dbTsToLocalDay(ts: string): string {
  return epochToLocalDay(dbTsToEpoch(ts))
}
