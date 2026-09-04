/**
 * A saved view is a name plus a serialized filter query string. Deciding whether
 * the bill list is "currently showing" a view therefore means comparing two query
 * strings — and that comparison has to be order-independent, because the filter
 * sync effect serializes repeated params (subject, tag, status) in whatever order
 * the underlying state arrays happen to hold.
 *
 * Two params are excluded from the comparison:
 *   - `view`, because an applied view puts its own slug in the URL and would
 *     otherwise never match its own stored query.
 *   - `page`, because pagination is not filter state.
 */

const EXCLUDED_PARAMS = new Set(['view', 'page'])

export function normalizeViewQuery(search: string): string {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
  const pairs: Array<[string, string]> = []
  for (const [key, value] of params.entries()) {
    if (EXCLUDED_PARAMS.has(key)) continue
    pairs.push([key, value])
  }
  pairs.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1))
  const out = new URLSearchParams()
  for (const [key, value] of pairs) out.append(key, value)
  return out.toString()
}

export function findActiveView<T extends { id: string; query: string }>(
  currentSearch: string,
  views: T[],
): T | null {
  const params = new URLSearchParams(currentSearch.startsWith('?') ? currentSearch.slice(1) : currentSearch)
  const activeId = params.get('view')
  const current = normalizeViewQuery(currentSearch)

  // An empty filter state is "All bills", never a view — a view with no
  // filters is rejected at creation — UNLESS the URL is carrying the short
  // `?view=<id>` form, where the filters that describe the view are not
  // spelled out in the URL at all. In that form, trust the id directly: the
  // sync effect only ever produces this shape once the applied filters
  // actually match the named view.
  if (current === '') {
    if (!activeId) return null
    return views.find(v => v.id === activeId) ?? null
  }

  // Expanded form: filters are spelled out in the URL. Match by (normalized)
  // query as before, but when several views share the same query, prefer the
  // one the URL's `view` param actually names — otherwise applying the
  // second of two identically-filtered views would mislabel itself as the
  // first.
  const matches = views.filter(v => normalizeViewQuery(v.query) === current)
  if (matches.length === 0) return null
  if (activeId) {
    const byId = matches.find(v => v.id === activeId)
    if (byId) return byId
  }
  return matches[0]
}
