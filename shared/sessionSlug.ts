/**
 * Converts a LegiScan session name to a URL slug.
 * "2026-2027 Regular Session" → "2026-2027"
 * "2026 1st Special Session" → "2026-s1"
 * "2025 Regular Session"     → "2025"
 */
export function sessionToSlug(sessionName: string): string {
  const special = sessionName.match(/(\d{4}(?:-\d{4})?)\s+(\d+)(?:st|nd|rd|th)\s+special/i)
  if (special) return `${special[1]}-s${special[2]}`
  const m = sessionName.match(/^(\d{4}(?:-\d{4})?)/)
  return m ? m[1] : sessionName.toLowerCase().replace(/[^a-z0-9]+/g, '-')
}

/**
 * Canonical bill URL: /STATE/SESSION/BILL (e.g. /RI/2026/HB0209).
 * Falls back to /bills/:id when sessionSlug is unavailable.
 */
export function billUrl(bill: {
  id?: string
  state?: string | null
  sessionSlug?: string | null
  session?: string | null
  billNumber: string
}): string {
  const slug = bill.sessionSlug ?? (bill.session ? sessionToSlug(bill.session) : null)
  if (!slug || !bill.state) {
    if (bill.id) return `/bills/${bill.id}`
    if (slug) return `/${slug}/${bill.billNumber}`
    return '#'
  }
  return `/${bill.state.toUpperCase()}/${slug}/${bill.billNumber}`
}
