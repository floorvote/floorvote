/**
 * Subject names as stored in bills.subjects (a JSON array). Deduped with
 * first-occurrence order preserved, mirroring filterTagsToTaxonomy's contract
 * so the two topical vocabularies behave the same way on read.
 */
export function parseSubjects(raw: unknown): string[] {
  if (typeof raw !== 'string' || raw.length === 0) return []
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return [] }
  if (!Array.isArray(parsed)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of parsed) {
    if (typeof item !== 'string' || item.length === 0) continue
    if (seen.has(item)) continue
    seen.add(item)
    out.push(item)
  }
  return out
}

/**
 * Filter values are namespaced by state because the vocabularies are not
 * comparable across states — New Jersey publishes 44 coarse terms, Arizona
 * 6,449 fine-grained ones. An unnamespaced "Education" would OR across both.
 */
export function encodeSubjectFilter(state: string, name: string): string {
  return `${state}:${name}`
}

/** Split on the FIRST colon only — subject names legitimately contain colons. */
export function decodeSubjectFilter(value: string): { state: string; name: string } | null {
  const idx = value.indexOf(':')
  if (idx <= 0) return null
  const state = value.slice(0, idx)
  const name = value.slice(idx + 1)
  if (name.length === 0) return null
  return { state, name }
}
