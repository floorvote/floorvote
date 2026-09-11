/**
 * Keyword matching. THE single implementation — `api`, `central` and the
 * openstates scripts all import from here.
 *
 * This replaced a hand-mirrored pair of matchers plus four script copies, and a
 * hardcoded `WORD_BOUNDARY_KEYWORDS = new Set(['election'])` that existed
 * because `election` is a substring of `selection`. Operators can now express
 * that themselves, for any keyword.
 *
 * Syntax: `*` matches any run of characters, `#` matches exactly one digit,
 * and a keyword with no wildcard matches a whole token. Letters and digits are
 * both token characters; each `*` relaxes the boundary on that side.
 *
 *   election     exact token   election
 *   election*    starts a token election, elections, election2024
 *   *election    ends a token   election, selection, reelection
 *   *election*   anywhere       all of the above
 *   5.#*         a statute chapter  5.02, 5.35  (not 115.385, not "(b) 5.,")
 *   19.85        an exact section   19.85  (not 19.851)
 *   *            every bill     (only when it is the sole entry)
 *
 * The boundary class is [a-zA-Z0-9]: a digit is inside a token exactly as a
 * letter is, so `election` does NOT match "election2024" — `election*` does.
 * The class was letters-only until statute citations needed expressing. Bill
 * descriptions lead with the sections a bill affects ("An Act to amend 6.86
 * (1) (a) 2.; to create 5.02 of the statutes; Relating to: ..."), which makes a
 * chapter a usable intake signal without reading bill text — but only if the
 * left boundary blocks on digits, or chapter 5 also matches 115.385. Measured
 * across 32,750 bills in seven tenants when the class changed: zero keywords
 * in use had a digit directly abutting them, so nothing changed but this.
 *
 * `#` exists because `*` is unbounded. A citation's trailing subdivision is
 * "5." followed by punctuation, so `5.*` matches subdivisions of every other
 * chapter too (measured 32% precision); requiring a digit after the dot is
 * what separates a chapter from a subdivision (100%). `#` was a literal
 * character before it was a token — no keyword in any tenant used one.
 * Claiming it is a one-way door, taken deliberately: there is no escape
 * syntax, so no keyword can contain a literal '#' from here on. Nothing in
 * bill text needs one today; a keyword that did would have to be spelled
 * around it, or the syntax would need an escape this file does not have.
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

const BOUNDARY_L = '(?<![a-zA-Z0-9])'
const BOUNDARY_R = '(?![a-zA-Z0-9])'

/** The digit token. One `#` in a pattern matches exactly one digit. */
export const DIGIT_TOKEN = '#'

function escapeLiteral(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * A compiled keyword: the anchored RegExp, plus the longest literal run in the
 * pattern, lowercased, for the prefilter in `matchesUnion`.
 */
type Compiled = { re: RegExp; lit: string }

// The matcher runs once per keyword per bill, so compiling on every call would
// rebuild the same RegExp thousands of times in a queue batch. Keyed by the raw
// pattern; the set of distinct patterns is bounded by tenant config size.
const cache = new Map<string, Compiled | null>()

/**
 * Compile one keyword, or null if it is degenerate (empty, whitespace-only, or
 * the bare wildcard, which callers handle before reaching here).
 */
function compilePattern(pattern: string): Compiled | null {
  const cached = cache.get(pattern)
  if (cached !== undefined) return cached

  const trimmed = pattern.trim()
  let compiled: Compiled | null = null
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
    // Runs of '#' are NOT collapsed: each one means one digit, so `5.##` and
    // `5.#` are different patterns. A '#' cannot introduce backtracking the way
    // a stray '*' can — `\d` consumes exactly one character.
    const body = parts
      .map(part => part.split(DIGIT_TOKEN).map(escapeLiteral).join('\\d'))
      .join('.*')
    const left = parts[0] === '' ? '' : BOUNDARY_L
    const right = parts[parts.length - 1] === '' ? '' : BOUNDARY_R
    const re = new RegExp(`${left}${body}${right}`, 'i')
    // Every literal segment must appear verbatim for the regex to match, so the
    // longest one is a sound and cheap precondition. Lowercased because the
    // regex is case-insensitive and the prefilter compares against lowercased
    // text; empty when the pattern is all stars and separators, in which case
    // the prefilter is skipped.
    //
    // Split on '#' as well as '*': a '#' stands for a digit the prefilter
    // cannot know, so a run containing one is not a verbatim literal. Taking
    // the whole run would put a '#' into the substring test, which no bill text
    // contains, and the prefilter would reject every bill before the regex ran
    // — turning `5.#*` into a keyword that silently matches nothing.
    const lit = parts
      .flatMap(part => part.split(DIGIT_TOKEN))
      .filter(x => x !== '')
      .sort((a, b) => b.length - a.length)[0] ?? ''
    compiled = { re, lit: lit.toLowerCase() }
  }
  cache.set(pattern, compiled)
  return compiled
}

/**
 * The anchored RegExp for one keyword, or null if it is degenerate.
 *
 * Retained as the public shape callers and tests already depend on; the
 * matcher itself uses `compilePattern` so it can reach the prefilter literal.
 */
export function compileKeyword(pattern: string): RegExp | null {
  return compilePattern(pattern)?.re ?? null
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
  // Lowercased once per call for the prefilter below. The regexes carry 'i' and
  // are tested against the original text, so this is only ever a fast reject.
  const lower = text.toLowerCase()
  for (const kw of list) {
    const compiled = compilePattern(kw)
    if (!compiled) continue
    // A glob can only match where its literal runs appear verbatim, so a cheap
    // substring test rejects the overwhelming majority of bills before the
    // regex engine is involved. This matters: the lookbehind and lookahead
    // assertions are far more expensive than String.includes, and replacing
    // includes with a bare regex made a full-corpus keyword resync ~30x slower
    // (325ms -> 9.8s over 83k bills). The prefilter puts that back (290ms) with
    // an identical result set, because a pattern whose longest literal is
    // absent cannot match.
    if (compiled.lit !== '' && !lower.includes(compiled.lit)) continue
    if (compiled.re.test(text)) return { matched: true, keyword: kw }
  }
  return { matched: false, keyword: '' }
}

/** Boolean form of `matchesUnion`. */
export function matchesKeywords(text: string, keywords: string[]): boolean {
  return matchesUnion(text, keywords).matched
}
