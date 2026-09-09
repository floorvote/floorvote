/**
 * Keyword matching. THE single implementation — `api`, `central` and the
 * openstates scripts all import from here.
 *
 * This replaced a hand-mirrored pair of matchers plus four script copies, and a
 * hardcoded `WORD_BOUNDARY_KEYWORDS = new Set(['election'])` that existed
 * because `election` is a substring of `selection`. Operators can now express
 * that themselves, for any keyword.
 *
 * Syntax: `*` means "any characters". A keyword with no `*` matches a whole
 * word; each `*` relaxes the boundary on that side.
 *
 *   election     exact word    election
 *   election*    starts a word election, elections
 *   *election    ends a word   election, selection, reelection
 *   *election*   anywhere      all of the above
 *   *            every bill    (only when it is the sole entry)
 *
 * The boundary class is [a-zA-Z], so digits do not block: `election` matches
 * "election2024". That is inherited from the lookbehind this replaced and kept
 * deliberately, since bill text pairs words with years constantly.
 *
 * The boundary class is also ASCII-only, so accented and non-Latin letters
 * never count as boundaries: `élection` matches inside `réélection`, silently
 * behaving like a substring keyword instead of a whole-word one.
 */

/**
 * The wildcard sentinel. Matches every bill, but ONLY as the sole entry in a
 * list — see `effectiveKeywords`. Under glob semantics this is just the pattern
 * that matches anything, so it is the degenerate case of the general rule
 * rather than a special case beside it.
 */
export const WILDCARD_KEYWORD = '*'

/**
 * True for any keyword that is nothing but asterisks after trimming (`*`,
 * `**`, `***`, ...). All of these are the wildcard: `'*'.split('*')` and
 * `'**'.split('*')` both produce only empty segments, so they compile to the
 * same unanchored "match anything" pattern. `compileKeyword` and
 * `effectiveKeywords` both call this so the two cannot drift apart.
 */
export function isWildcardKeyword(pattern: string): boolean {
  const trimmed = pattern.trim()
  return trimmed.length > 0 && /^\*+$/.test(trimmed)
}

const BOUNDARY_L = '(?<![a-zA-Z])'
const BOUNDARY_R = '(?![a-zA-Z])'

function escapeLiteral(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// The matcher runs once per keyword per bill, so compiling on every call would
// rebuild the same RegExp thousands of times in a queue batch. Keyed by the raw
// pattern; the set of distinct patterns is bounded by tenant config size.
const cache = new Map<string, RegExp | null>()

/**
 * Compile one keyword to an anchored RegExp, or null if it is degenerate
 * (empty, whitespace-only, or the bare wildcard, which callers handle before
 * reaching here).
 */
export function compileKeyword(pattern: string): RegExp | null {
  const cached = cache.get(pattern)
  if (cached !== undefined) return cached

  const trimmed = pattern.trim()
  let re: RegExp | null = null
  if (trimmed.length > 0 && !isWildcardKeyword(trimmed)) {
    // Collapse runs of '*' to one before splitting. An all-asterisk pattern is
    // caught by isWildcardKeyword above, but an INTERIOR run (e.g. `a***b`) is
    // not — left uncollapsed it splits into that many empty segments, each
    // becoming its own `.*` in the joined body (`a.*.*.*b`). Each extra `.*`
    // is a separate backtracking choice point, and they compound
    // multiplicatively against each other on a failing match, so a handful of
    // stray stars on a long line can take the regex engine from microseconds
    // to effectively hanging (catastrophic backtracking). Collapsing first
    // means a run of stars always compiles identically to a single `*`.
    const collapsed = trimmed.replace(/\*+/g, '*')
    const parts = collapsed.split('*')
    const body = parts.map(escapeLiteral).join('.*')
    const left = parts[0] === '' ? '' : BOUNDARY_L
    const right = parts[parts.length - 1] === '' ? '' : BOUNDARY_R
    re = new RegExp(`${left}${body}${right}`, 'i')
  }
  cache.set(pattern, re)
  return re
}

/**
 * Resolve a stored list to the keywords that actually apply.
 *
 * A bare `*` matches everything only when it is alone. In a longer list it is
 * dropped: `['election', '*']` is far more likely a mistake than an intent,
 * since the wildcard would make every sibling redundant.
 */
function effectiveKeywords(keywords: string[]): { wildcard: boolean; list: string[] } {
  if (keywords.length === 1 && isWildcardKeyword(keywords[0])) {
    return { wildcard: true, list: [] }
  }
  return { wildcard: false, list: keywords.filter(k => !isWildcardKeyword(k)) }
}

/** Match `text` against the union of `keywords`, reporting which one hit. */
export function matchesUnion(text: string, keywords: string[]): { matched: boolean; keyword: string } {
  const { wildcard, list } = effectiveKeywords(keywords)
  // Always report the canonical WILDCARD_KEYWORD ('*') here, even though the
  // literal stored/sole entry might be '**' or '***'. Callers persist this
  // value as matched_keyword and later compare it against WILDCARD_KEYWORD
  // (or isWildcardKeyword) to decide things like "this came from the
  // catch-all, skip provider-side handling for it" — normalizing here keeps
  // that comparison exact-match-safe instead of forcing every call site to
  // re-derive wildcard-ness from an arbitrary run of stars.
  if (wildcard) return { matched: true, keyword: WILDCARD_KEYWORD }
  for (const kw of list) {
    const re = compileKeyword(kw)
    if (re && re.test(text)) return { matched: true, keyword: kw }
  }
  return { matched: false, keyword: '' }
}

/** Boolean form of `matchesUnion`. */
export function matchesKeywords(text: string, keywords: string[]): boolean {
  return matchesUnion(text, keywords).matched
}
