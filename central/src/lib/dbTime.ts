// SQLite datetime('now') equivalent computed in JS: UTC, space-separated,
// no T / Z / fractional seconds. Use only when a plain string is needed in
// app code; prefer omitting the column (default fires) or sql`(datetime('now'))`.
export function nowDb(): string {
  return new Date().toISOString().slice(0, 19).replace('T', ' ') // ts-write-ok: this IS the space-format conversion
}
