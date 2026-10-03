/**
 * Multi-select custom field values are stored as a JSON array string in
 * `bill_custom_field_values.value` (e.g. `["urgent","monitor"]`). Legacy or
 * single-select rows hold a bare string, so a value that does not parse as a
 * JSON array is treated as a single-element selection.
 */
export function parseStoredMulti(raw: string | undefined | null): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) return parsed
  } catch { /* fall through */ }
  return [raw]
}

/** One entry in a 'document' custom field: a titled link to a document the
 *  team keeps elsewhere (testimony, a comment letter, a redline). FloorVote
 *  stores only the title and URL; the document keeps its own sharing settings. */
export type DocumentLink = { title: string; url: string }

export const DOCUMENT_TITLE_MAX = 200
export const DOCUMENT_URL_MAX = 2000
export const DOCUMENTS_PER_FIELD_MAX = 20

/** Checks one document entry from a request: a non-empty title and a full
 *  https URL. Returns the entry to store (title trimmed, URL normalized) or the
 *  reason it was refused. Only https is accepted, so a stored URL is always
 *  safe to render as a link. */
export function normalizeDocument(raw: unknown): { ok: true; doc: DocumentLink } | { ok: false; reason: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'each document must be { title, url }' }
  const { title, url } = raw as { title?: unknown; url?: unknown }
  if (typeof title !== 'string' || !title.trim()) return { ok: false, reason: 'each document needs a title' }
  if (title.trim().length > DOCUMENT_TITLE_MAX) return { ok: false, reason: `a document title can be at most ${DOCUMENT_TITLE_MAX} characters` }
  if (typeof url !== 'string' || !url.trim()) return { ok: false, reason: 'each document needs a link' }
  if (url.trim().length > DOCUMENT_URL_MAX) return { ok: false, reason: `a document link can be at most ${DOCUMENT_URL_MAX} characters` }
  let parsed: URL
  try { parsed = new URL(url.trim()) } catch { return { ok: false, reason: 'paste a full link, starting with https://' } }
  if (parsed.protocol !== 'https:') return { ok: false, reason: 'links must start with https://' }
  return { ok: true, doc: { title: title.trim(), url: parsed.toString() } }
}

/** Reads a stored 'document' field value (a JSON array of { title, url }).
 *  Anything malformed, or any entry that is not an https link, is dropped
 *  rather than rendered. */
export function parseStoredDocuments(raw: string | undefined | null): DocumentLink[] {
  if (!raw) return []
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return [] }
  if (!Array.isArray(parsed)) return []
  const docs: DocumentLink[] = []
  for (const entry of parsed) {
    const r = normalizeDocument(entry)
    if (r.ok) docs.push(r.doc)
  }
  return docs
}
