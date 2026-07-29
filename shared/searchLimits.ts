// Cloudflare D1 rejects any LIKE/GLOB pattern longer than 50 bytes with
// "LIKE or GLOB pattern too complex: SQLITE_ERROR". Bill search wraps a term as
// '%' + term + '%' (2 extra bytes), so a term is safe up to 48 bytes.
export const MAX_SEARCH_TERM_BYTES = 48

// Max tokens honored across a whole search query. D1 rejects a statement with
// more than 100 bound parameters ("too many SQL variables"), and each search
// token emits up to 3 LIKE params, so an unbounded token count (e.g. a long
// pasted phrase — one segment, many words) overflows the cap. 15 keeps search's
// own params well under 100 with headroom for the other active filters sharing
// the statement; real searches are far shorter.
export const MAX_SEARCH_TOKENS = 15

// UTF-8 byte length (D1 counts bytes, not characters).
export function byteLength(s: string): number {
  return new TextEncoder().encode(s).length
}

// Longest prefix of `s` whose UTF-8 length is <= maxBytes, never splitting a
// character. Iterates by code point (for..of), so surrogate pairs stay intact.
export function truncateToBytes(s: string, maxBytes: number): string {
  if (byteLength(s) <= maxBytes) return s
  let out = ''
  let bytes = 0
  for (const ch of s) {
    const chBytes = byteLength(ch)
    if (bytes + chBytes > maxBytes) break
    out += ch
    bytes += chBytes
  }
  return out
}

// ── Search query tokenizer ──────────────────────────────────────────────
// Grammar: comma = OR (binds loosest), space = AND, "quotes" = atomic phrase.
// Moved here from api/src/routes/billsApi/query.ts so the server's search
// builder and the client's "term too long" hint tokenize identically.

// Split on commas that fall outside double quotes.
export function splitSegments(q: string): string[] {
  const segments: string[] = []
  let current = ''
  let inQuotes = false
  for (const ch of q) {
    if (ch === '"') { inQuotes = !inQuotes; current += ch }
    else if (ch === ',' && !inQuotes) { segments.push(current); current = '' }
    else { current += ch }
  }
  segments.push(current)
  return segments.map(s => s.trim()).filter(Boolean)
}

// Quoted spans become single phrase tokens; stray quote chars are stripped so
// an unbalanced quote degrades to a best-effort token search.
export function tokenizeSegment(segment: string): string[] {
  const tokens: string[] = []
  const re = /"([^"]*)"|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(segment)) !== null) {
    if (m[1] !== undefined) { const text = m[1].trim(); if (text) tokens.push(text) }
    else { const text = m[2].replace(/"/g, ''); if (text) tokens.push(text) }
  }
  return tokens
}

// True when any token the user typed exceeds the byte budget and will be
// visibly truncated by the search builder — drives the UI "term too long" hint.
// Deliberately ignores the despaced bill-number clause: that clause is dropped
// silently server-side and does not change the results a user perceives.
export function searchTermTooLong(q: string): boolean {
  return splitSegments(q).some(seg =>
    tokenizeSegment(seg).some(t => byteLength(t) > MAX_SEARCH_TERM_BYTES),
  )
}

// Active user-facing search warnings, one short sentence each. A composable
// "registry": every guarded D1 limit contributes at most one message, so the UI
// renders 0, 1, or 2 lines with no per-combination text — add a new limit here
// and it composes automatically. Each message mirrors what buildSearchCondition
// actually does to the query. Order is stable (term length, then term count).
export function searchWarnings(q: string): string[] {
  const warnings: string[] = []
  // A — a term is too long and gets truncated to a prefix.
  if (searchTermTooLong(q)) warnings.push('Long search terms are shortened.')
  // B — too many terms; the builder keeps only the first MAX_SEARCH_TOKENS.
  const tokenCount = splitSegments(q).reduce((n, seg) => n + tokenizeSegment(seg).length, 0)
  if (tokenCount > MAX_SEARCH_TOKENS) warnings.push(`Only the first ${MAX_SEARCH_TOKENS} terms are searched.`)
  return warnings
}
