export interface ImportRow {
  title: string
  date: string            // YYYY-MM-DD
  details: string | null
  time: string | null
  location: string | null
  url: string | null
  /** ICS only: the source VEVENT UID. When absent, importUid derives one from date+title. */
  uid?: string
  /** ICS only: IANA zone for a timed event. */
  timezone?: string | null
}

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('')
}

const normTitle = (t: string) => t.trim().toLowerCase().replace(/\s+/g, ' ')

export async function importUid(row: ImportRow): Promise<string> {
  return `import-${await sha256Hex(`${row.date}|${normTitle(row.title)}`)}@example.com`
}

export async function importEventHash(row: ImportRow): Promise<string> {
  const fields = [row.date, row.title.trim(), row.details ?? '', row.time ?? '', row.location ?? '', row.url ?? '']
  // Timezone joins the hash ONLY when set. Appending it unconditionally would change the
  // hash of every already-imported CSV event, so an unchanged re-upload would report them
  // all as `updated` and bump every subscriber's SEQUENCE for no reason.
  if (row.timezone) fields.push(row.timezone)
  return sha256Hex(fields.join('|'))
}
