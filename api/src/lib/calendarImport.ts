export interface ImportRow {
  title: string
  date: string            // YYYY-MM-DD
  details: string | null
  time: string | null
  location: string | null
  url: string | null
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
  return sha256Hex([row.date, row.title.trim(), row.details ?? '', row.time ?? '', row.location ?? '', row.url ?? ''].join('|'))
}
