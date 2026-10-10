/**
 * Converts a session name to a URL slug.
 * "2026-2027 Regular Session" → "2026-2027"
 * "2026 1st Special Session" → "2026-s1"
 * "2026 Special Session 1"   → "2026-s1"   (Maryland)
 * "2026 Special Session II"  → "2026-s2"   (Virginia)
 * "2025 Regular Session"     → "2025"
 *
 * This is the slug a session asks for. Central stores each session's slug,
 * unique within its state (a second session asking for one gets "-2"), and
 * sends it with each bill. Tenants call this only for bills stored before
 * central sent it.
 */
const COUNCIL_PERIOD = /\bCouncil Period (\d+)\b/i
const ROMAN: Record<string, number> = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10 }

export function sessionToSlug(sessionName: string): string {
  // A DC Council Period gets its own slug ("cp26"). Its year span alone
  // ("2025-2026") is what any other DC session for those years slugs to, so
  // the bill URL could resolve to the wrong bill.
  const cp = sessionName.match(COUNCIL_PERIOD)
  if (cp) return `cp${cp[1]}`
  const special = sessionName.match(/(\d{4}(?:-\d{4})?)\s+(\d+)(?:st|nd|rd|th)\s+special/i)
  if (special) return `${special[1]}-s${special[2]}`
  // The number after "Special Session", as Maryland and Virginia name theirs.
  // Without this, each one slugs to its year, which its regular session holds.
  const numbered = sessionName.match(/^(\d{4}(?:-\d{4})?)\s+special\s+session\s+(\d+|[ivx]+)\b/i)
  const n = numbered && (ROMAN[numbered[2].toLowerCase()] ?? Number(numbered[2]))
  if (numbered && n) return `${numbered[1]}-s${n}`
  const m = sessionName.match(/^(\d{4}(?:-\d{4})?)/)
  return m ? m[1] : sessionName.toLowerCase().replace(/[^a-z0-9]+/g, '-')
}

/**
 * The slug an older URL may use for this session, or null. Before Council
 * Periods had their own slug, "2025-2026 Council Period 26" slugged to
 * "2025-2026", and links made then should keep working where they are
 * unambiguous.
 */
export function legacySessionSlug(sessionName: string): string | null {
  if (!COUNCIL_PERIOD.test(sessionName)) return null
  return sessionName.match(/^(\d{4}(?:-\d{4})?)/)?.[1] ?? null
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
