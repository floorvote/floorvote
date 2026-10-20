// SQLite datetime('now') equivalent computed in JS: UTC, space-separated,
// no T / Z / fractional seconds. Use only when a plain string is needed in
// app code; prefer omitting the column (default fires) or sql`(datetime('now'))`.
export function toDb(d: Date): string {
  return d.toISOString().slice(0, 19).replace('T', ' ') // ts-write-ok: this IS the space-format conversion
}

export function nowDb(): string {
  return toDb(new Date())
}

/** The stored-format time `ms` before `now`, for comparing with stored times. */
export function dbTimeAgo(ms: number, now: Date = new Date()): string {
  return toDb(new Date(now.getTime() - ms))
}
