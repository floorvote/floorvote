import { DIFF_DELETE, DIFF_EQUAL, DIFF_INSERT, makeDiff, match, type Diff } from '@sanity/diff-match-patch'
import { KEEP_TAG } from './billText'
import type { ClaimSource, ClaimSourceStatus, ResolvedClaimSource, Span } from './claimSources'

// Resolving claim sources (#569, design in #560): for each claim the model
// returned, find the claim in the summary the bill stores, and the quote in the
// document the model read, and record how the quote resolved.
//
// This runs at analysis time (queue/processor.ts), when the instance has the
// document in hand, and nowhere else:
//
// - Reading doesn't have to fetch the text from central and run the matcher on
//   every page view. That is up to a few hundred thousand characters and a
//   bitap scan per quote.
// - A status is stored on every item, so #573's counts by status are one query,
//   whether or not anyone has opened the bill.
// - The location is computed against exactly the text the model read. A later
//   resolve would see whatever the document has become.
//
// The matcher is `@sanity/diff-match-patch`'s `match` and `makeDiff`, and the
// head-and-tail anchoring its own `applyPatches` uses for a pattern too long
// for `match`. `match` takes a pattern of 32 characters or fewer (its bitap
// mask is 32 bits), so a longer quote is located by its first 32 characters and
// its last 32, then the region between them is scored with `makeDiff`.

/** The longest pattern `match` takes: the library's `MAX_BITS`, which it does not export. */
const MAX_BITS = 32

/** The least similarity (1 minus the share of characters that differ) at which a quote counts as found. */
const MIN_SIMILARITY = 0.8

/**
 * How loosely `match` may score a candidate. A candidate's score is its error
 * rate plus its distance from the expected location divided by `distance`, so
 * searching a long document from its start needs `distance` large enough that
 * position costs at most `POSITION_BUDGET`, and the threshold leaves room for
 * the errors on top of it. `match` only proposes a location. `makeDiff` decides
 * whether it is the quote.
 */
const POSITION_BUDGET = 0.1
const ERROR_BUDGET = 0.25

/** Characters that are dropped: soft hyphens and zero-width characters. */
const INVISIBLE = /[­​-‍⁠﻿]/

/** Curly quotes fold to straight ones, and every dash to a hyphen. */
const FOLD: Record<string, string> = {
  '‘': "'", '’': "'", '‚': "'", '‛': "'", '′': "'",
  '“': '"', '”': '"', '„': '"', '‟': '"', '″': '"',
  '‐': '-', '‑': '-', '‒': '-', '–': '-', '—': '-', '―': '-', '−': '-',
}

/** A tag the text may carry. Retained redline markup is capped well below any real tag's length. */
const TAG = /<[^>]{0,300}>/y

type Norm = {
  s: string
  /** `map[i]` is where normalized character `i` is in the original. */
  map: number[]
}

/**
 * Collapse every run of whitespace to one space, and drop leading whitespace.
 * With `tags`, also drop the retained redline markup (`billHtmlToText` keeps
 * `<u>`, `<strike>`, `<font>`, and the like, so the model and the matcher see
 * it). With `fold`, also fold curly quotes and dashes and drop invisible
 * characters. The map takes any range of the result back to the original.
 */
function normalize(text: string, opts: { tags: boolean; fold: boolean }): Norm {
  const out: string[] = []
  const map: number[] = []
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (opts.tags && ch === '<') {
      TAG.lastIndex = i
      const m = TAG.exec(text)
      if (m && KEEP_TAG.test(m[0])) { i += m[0].length; continue }
    }
    if (opts.fold && INVISIBLE.test(ch)) { i++; continue }
    if (/\s/.test(ch)) {
      if (out.length > 0 && out[out.length - 1] !== ' ') { out.push(' '); map.push(i) }
      i++
      continue
    }
    out.push(opts.fold ? FOLD[ch] ?? ch : ch)
    map.push(i)
    i++
  }
  return { s: out.join(''), map }
}

/** A normalized string without its trailing space. */
function trimEnd(n: Norm): Norm {
  return n.s.endsWith(' ') ? { s: n.s.slice(0, -1), map: n.map.slice(0, -1) } : n
}

/** The original range a range of a normalized string covers. */
function original(n: Norm, start: number, end: number): Span {
  return { start: n.map[start], end: n.map[end - 1] + 1 }
}

/** `[start, end)` of `needle` in `summary`, exact or with whitespace normalized, or null. First one wins. */
function findClaim(summary: string, claim: string): Span | null {
  if (claim.trim().length === 0) return null
  const exact = summary.indexOf(claim)
  if (exact !== -1) return { start: exact, end: exact + claim.length }
  const hay = normalize(summary, { tags: false, fold: false })
  const needle = trimEnd(normalize(claim, { tags: false, fold: false }))
  const at = hay.s.indexOf(needle.s)
  return at === -1 ? null : original(hay, at, at + needle.s.length)
}

/**
 * How alike a quote and the region found for it are. Region text before the
 * first matched character and after the last is only where `match` put the
 * window, not part of the passage: it is trimmed, and isn't an error. Quote
 * text left unmatched at either end is.
 */
function align(quote: string, region: string, budget: Budget): { similarity: number; start: number; end: number } {
  charge(budget, Math.ceil(((quote.length * region.length) / DIFF_CELLS_PER_UNIT) * widthFactor(quote, region)))
  const diffs = makeDiff(quote, region)
  const firstEq = diffs.findIndex(d => d[0] === DIFF_EQUAL)
  if (firstEq === -1) return { similarity: 0, start: 0, end: 0 }
  let lastEq = diffs.length - 1
  while (diffs[lastEq][0] !== DIFF_EQUAL) lastEq--

  const sum = (run: Diff[], op: number) => run.reduce((n, d) => (d[0] === op ? n + d[1].length : n), 0)
  const lead = diffs.slice(0, firstEq)
  const trail = diffs.slice(lastEq + 1)
  const start = sum(lead, DIFF_DELETE) === 0 ? sum(lead, DIFF_INSERT) : 0
  const cut = sum(trail, DIFF_DELETE) === 0 ? sum(trail, DIFF_INSERT) : 0
  const end = region.length - cut

  // Edits between the first and last equal run: the library's own distance, a
  // run of inserts and deletes between equalities counting as the longer.
  let distance = sum(lead, DIFF_DELETE) + sum(trail, DIFF_DELETE)
  let ins = 0
  let del = 0
  for (const [op, text] of diffs.slice(firstEq, lastEq + 1)) {
    if (op === DIFF_INSERT) ins += text.length
    else if (op === DIFF_DELETE) del += text.length
    else { distance += Math.max(ins, del); ins = 0; del = 0 }
  }
  const longest = Math.max(quote.length, end - start)
  return { similarity: longest === 0 ? 1 : 1 - distance / longest, start, end }
}

/**
 * The most items resolved for one bill, and the longest quote searched fuzzily.
 * A model answer past either is not a real claim list, and the cost of matching
 * is linear in both, so a degenerate answer must not use up the analysis.
 */
const MAX_ITEMS = 100
const MAX_FUZZY_QUOTE = 2000

/**
 * The fuzzy search's budget for one bill, in units of work, which bounds its
 * CPU time. A Worker's clock does not move during computation, so the bound
 * counts work rather than timing it. Every library call is charged before it
 * runs, and a call that would go past what is left is not made: the item stops
 * searching, stays `ungrounded`, and is counted in `unsearched`. So the total
 * never passes the budget, whatever the quotes and the document.
 *
 * A unit is one character of Latin text handed to `match`, which is about what
 * it costs. A search from the start of the document costs the same whether it
 * finds its pattern or not (a pass over the document per error it allows,
 * measured at 0.17 to 0.22 µs a character on 0.1 to 2 million characters, a
 * hit with eight to eleven errors the dearest), so it is charged the whole
 * document. The one exception is a pattern that is in the text exactly
 * (`matchCost`). A search near a place is handed only the text it can reach
 * (`proposeNear`), about 3,000 characters, so it costs that. A `makeDiff`
 * costs its two lengths multiplied (measured at up to 12 ns a cell for unlike
 * Latin texts), so it is charged that over `DIFF_CELLS_PER_UNIT`. A character
 * above U+00FF (Cyrillic, Greek, CJK) costs both about three times as much
 * (`widthFactor`), so every charge is scaled by the share of them in what the
 * call is handed. At the dearest rates measured, 20 million units are about
 * 4.4 seconds in any script.
 *
 * Exact and normalized matches are `indexOf` scans, and always run for every
 * item, outside the budget: up to about a second on 2 million characters of
 * ordinary text, so the whole is about 4 to 7 seconds (the dearest measured:
 * English dense with symbols such as an ellipsis, a bullet, and a euro sign,
 * heavy on `makeDiff`). On degenerate text (one
 * character repeated, with a quote that nearly matches everywhere) `indexOf`
 * is quadratic, about 0.7 seconds a quote on a million characters, which no
 * bill has. The fuzzy searches go cheapest first, by what their first call
 * costs, so quotes whose head is in the document exactly go before quotes that
 * are absent, which cost two whole scans each and would otherwise spend the
 * budget on nothing.
 *
 * The tradeoff: on a typical bill (the median is about 9,000 characters of
 * text, and 100 quotes on 100,000 characters fit) every quote that can be
 * found is, for quotes up to about 1,000 characters (the median quote is
 * about 250 characters, and nine in ten are under about 530). A diff is
 * charged as if its texts were unlike, since what it costs is only known after
 * it runs, so a quote that is found costs about 30 times what it uses, and 100
 * quotes of 2,000 characters do not all fit. On a document of a million
 * characters or more, the budget runs out after a few dozen whole scans, and
 * many quotes are left `ungrounded` though some could be found. That is the
 * price of the bound. It depends only on the document and the quotes, never
 * on a clock.
 */
const WORK_BUDGET = 20_000_000
const DIFF_CELLS_PER_UNIT = 16

/**
 * How much more a character above U+00FF costs than a Latin one. V8 keeps a
 * one-character string for each code up to U+00FF and makes a new one for any
 * other, and both `match` and `makeDiff` look characters up that way. Measured
 * on a million characters: `match` 0.56 µs a character on Cyrillic and CJK
 * text against 0.20 on Latin, rising in line with their share (1.5 times at a
 * fifth of them), and `makeDiff` about twice. So a text all of them is charged
 * 3.5 times, conservatively.
 */
const WIDE_CHARACTER_COST = 2.5

/** The factor a call's charge is multiplied by: 1 for Latin text, more by the share of characters above U+00FF in it. */
function widthFactor(...texts: string[]): number {
  let wide = 0
  let all = 0
  for (const t of texts) {
    all += t.length
    for (let i = 0; i < t.length; i++) if (t.charCodeAt(i) > 0xff) wide++
  }
  return all === 0 ? 1 : 1 + (WIDE_CHARACTER_COST * wide) / all
}

/**
 * What is left of the bill's budget, how many items stopped for want of it,
 * the document's `widthFactor` (counted once), and where each pattern searched
 * from the start was found exactly (looked up once).
 */
type Budget = { left: number; skipped: number; docFactor: number; exactAt: Map<string, number> }

const OUT_OF_BUDGET = Symbol('out of budget')

/** Take `units` from the budget, or refuse the call that would cost them. */
function charge(budget: Budget, units: number): void {
  if (units > budget.left) throw OUT_OF_BUDGET
  budget.left -= units
}

/**
 * What a search from the start of `text` costs. A pattern that is in the text
 * exactly lowers `match`'s threshold to that place's score before it scans, so
 * its passes only reach as far as the first copy: a quarter of the characters
 * before it covers that (measured at under a fifth, 78 ms for a copy 1.9
 * million characters in). Any other pattern costs the whole text. In Latin
 * units: the caller scales it by the document's `widthFactor`.
 */
function matchCost(text: string, pattern: string, budget: Budget): number {
  let exact = budget.exactAt.get(pattern)
  if (exact === undefined) {
    exact = text.indexOf(pattern)
    budget.exactAt.set(pattern, exact)
  }
  return exact === -1 ? text.length : Math.ceil(exact / 4) + pattern.length
}

/** What must agree between a quote and what is found for it: digits, cardinal and ordinal words, and fractions. */
const CARDINAL_VALUES: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
  hundred: 100, thousand: 1000, million: 1e6, billion: 1e9,
}
const CARDINALS = Object.keys(CARDINAL_VALUES).join('|')

/** "five" is "fifth", "twenty" is "twentieth", and the rest take "th": every ordinal word from first to billionth. */
const IRREGULAR_ORDINALS: Record<string, string> = { one: 'first', two: 'second', three: 'third', five: 'fifth', eight: 'eighth', nine: 'ninth', twelve: 'twelfth' }
const ORDINAL_VALUES = new Map<string, number>(
  Object.entries(CARDINAL_VALUES).filter(([word]) => word !== 'zero').map(([word, value]) => [
    IRREGULAR_ORDINALS[word] ?? (word.endsWith('y') ? `${word.slice(0, -1)}ieth` : `${word}th`),
    value,
  ]),
)

// "1st" is one token, so its digit isn't read as a number of its own. An ordinal
// word takes a plural for a fraction ("two thirds"). A compound ("twenty-first")
// is its two words, each compared.
const NUMBER = new RegExp(`\\b\\d+(?:st|nd|rd|th)\\b|\\d+(?:[.,]\\d+)*|\\b(?:(?:${[...ORDINAL_VALUES.keys()].join('|')})s?|${CARDINALS}|half|halves|quarters?)\\b`, 'gi')

/** One number as a token that the same number written another way shares: "first" and "1st" are `1o`. */
function numberToken(raw: string): string {
  const t = raw.toLowerCase()
  const digitOrdinal = /^(\d+)(?:st|nd|rd|th)$/.exec(t)
  if (digitOrdinal) return `${Number(digitOrdinal[1])}o`
  const ordinal = ORDINAL_VALUES.get(t.endsWith('s') && ORDINAL_VALUES.has(t.slice(0, -1)) ? t.slice(0, -1) : t)
  if (ordinal !== undefined) return `${ordinal}o`
  if (t === 'halves') return 'half'
  if (t === 'quarters') return 'quarter'
  return t.replace(/,/g, '')
}

/** The numbers in a text: each token's count, and the way the first of them was written. */
function numbersOf(text: string): Map<string, { n: number; raw: string }> {
  const found = new Map<string, { n: number; raw: string }>()
  for (const m of text.match(NUMBER) ?? []) {
    const token = numberToken(m)
    const have = found.get(token)
    if (have) have.n++
    else found.set(token, { n: 1, raw: m })
  }
  return found
}

/**
 * What a line break can leave inside a number. Between two letters of a word:
 * a hyphen (and maybe a line number after it), or a line number between the
 * breaks. Anywhere else, only the line number, since "1-0" is two numbers and
 * not "10". Never a plain space.
 */
const WORD_BREAK = '(?:-\\s*(?:\\d{1,3}\\s+)?|\\s+\\d{1,3}\\s+)?'
const NUMBER_BREAK = '(?:[,.]?\\s+\\d{1,3}\\s+)?'
const LETTER = /[A-Za-z]/

/** Whether a number is in the text, written with a line break (and its line number) inside it. */
function brokenIn(raw: string, text: string): boolean {
  const chars = [...raw]
  const spelled = chars.map((c, k) => {
    const literal = c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    if (k === 0) return literal
    return (LETTER.test(chars[k - 1]) && LETTER.test(c) ? WORD_BREAK : NUMBER_BREAK) + literal
  }).join('')
  return new RegExp(`(?<![A-Za-z0-9])${spelled}(?![A-Za-z0-9])`, 'i').test(text)
}

/**
 * Whether every number in the quote is in what was found for it. "ten" is not
 * "thirty", 10 is not 15, "first" is not "third", and a half is not a quarter,
 * which a similarity score alone would let through. Numbers only in the found
 * text are fine: that is a line number. So is a number the source's line
 * breaking cut in two ("thir-", a line number, "ty"), which is looked for last.
 */
function numbersAgree(quote: string, found: string): boolean {
  const have = numbersOf(found)
  for (const [token, { n, raw }] of numbersOf(quote)) {
    if ((have.get(token)?.n ?? 0) >= n) continue
    if (n === 1 && brokenIn(raw, found)) continue
    return false
  }
  return true
}

const THRESHOLD = ERROR_BUDGET + POSITION_BUDGET

/**
 * How far from the start a search of the whole text may place a pattern and
 * still pass the threshold: far enough that the far end costs `POSITION_BUDGET`.
 */
function wideDistance(text: string): number {
  return Math.max(1000, Math.ceil(text.length / POSITION_BUDGET))
}

/**
 * Where `match` puts a pattern, searching from the start of the text, or -1. It
 * only proposes: `makeDiff` decides. Charged by `matchCost`, before it runs.
 */
function proposeFromStart(text: string, pattern: string, budget: Budget): number {
  charge(budget, Math.ceil(matchCost(text, pattern, budget) * budget.docFactor))
  return match(text, pattern, 0, { threshold: THRESHOLD, distance: wideDistance(text) })
}

/**
 * Where `match` puts a pattern near `expected`, or -1. A place further than
 * `THRESHOLD * distance` from `expected` scores past the threshold on distance
 * alone, so `match` is handed only that reach of the text, with two patterns'
 * length to spare on each side for a match with insertions, and finds what it
 * would in the whole text. It is charged the characters it is handed.
 */
function proposeNear(text: string, pattern: string, expected: number, distance: number, budget: Budget): number {
  const loc = Math.max(0, Math.min(expected, text.length))
  const reach = Math.ceil(THRESHOLD * distance) + 2 * pattern.length
  const from = Math.max(0, loc - reach)
  const window = text.slice(from, Math.min(text.length, loc + reach))
  charge(budget, Math.ceil(window.length * widthFactor(window)))
  const at = match(window, pattern, loc - from, { threshold: THRESHOLD, distance })
  return at === -1 ? -1 : at + from
}

/**
 * A quote's end (its first or last 32 characters), which `match` placed at
 * `at`: the range it covers if it is alike enough, else null.
 */
function anchorAt(text: string, pattern: string, at: number, budget: Budget): Span | null {
  if (at === -1) return null
  const scored = align(pattern, text.slice(at, at + pattern.length + 8), budget)
  return scored.similarity >= MIN_SIMILARITY ? { start: at + scored.start, end: at + scored.end } : null
}

/** The region `[from, to)` of the text, scored against the whole quote, or null when it is not alike enough. */
function regionAt(text: string, quote: string, from: number, to: number, budget: Budget): Span | null {
  const start = Math.max(0, from)
  const scored = align(quote, text.slice(start, to), budget)
  return scored.similarity >= MIN_SIMILARITY ? { start: start + scored.start, end: start + scored.end } : null
}

/** The whole region from a head to a tail, or null when either is missing or the tail is not after the head. */
function wholeAt(text: string, quote: string, head: number, tail: number, budget: Budget): Span | null {
  if (head === -1 || tail === -1 || tail <= head) return null
  return regionAt(text, quote, head, tail + MAX_BITS + 8, budget)
}

/** The head of a quote through the word that holds its 32nd character, and its tail from the word that holds its 32nd from last. */
function headWords(quote: string): string {
  const space = quote.indexOf(' ', MAX_BITS)
  return space === -1 ? quote : quote.slice(0, space)
}
function tailWords(quote: string): string {
  return quote.slice(quote.lastIndexOf(' ', quote.length - MAX_BITS) + 1)
}

type Fuzzy = { status: 'fuzzy' | 'anchored'; at: Span }

/**
 * Fuzzy, anchored-only, or neither, for a quote that isn't there exactly or
 * after normalizing. Works on normalized text and returns a range of it. A
 * result whose numbers disagree with the quote's is none.
 */
function findFuzzy(text: string, quote: string, budget: Budget): Fuzzy | null {
  try {
    return searchFuzzy(text, quote, budget)
  } catch (err) {
    // Out of budget partway: what the search had so far is not an answer.
    if (err !== OUT_OF_BUDGET) throw err
    budget.skipped++
    return null
  }
}

/** The pattern a quote's search starts with: the whole of a short quote, else its head. */
function firstPattern(quote: string): string {
  return quote.length <= MAX_BITS ? quote : quote.slice(0, MAX_BITS)
}

function searchFuzzy(text: string, quote: string, budget: Budget): Fuzzy | null {
  // Searched from the start of the document, a match at the far end costs at
  // most POSITION_BUDGET (the first of two identical passages scores a hair
  // better, which makes it the one found).
  if (quote.length <= MAX_BITS) {
    // No separate head and tail: the whole quote is the pattern.
    const at = proposeFromStart(text, quote, budget)
    const span = anchorAt(text, quote, at, budget)
    return span && numbersAgree(quote, text.slice(span.start, span.end)) ? { status: 'fuzzy', at: span } : null
  }

  const headPattern = firstPattern(quote)
  const tailPattern = quote.slice(-MAX_BITS)
  const near = Math.max(1000, 2 * quote.length)
  // A whole region alike enough is the passage, unless its numbers disagree:
  // then it is another passage like it (an earlier section with another number
  // whose head `match` preferred), and the search goes on. Null: keep looking.
  let numbersDiffered = false
  const whole = (span: Span | null): Fuzzy | null => {
    if (span === null) return null
    if (numbersAgree(quote, text.slice(span.start, span.end))) return { status: 'fuzzy', at: span }
    numbersDiffered = true
    return null
  }

  // The head from the start of the document, then the tail near where it would
  // be if the passage were whole, as the library's `applyPatches` does.
  const head = proposeFromStart(text, headPattern, budget)
  const tail = head !== -1
    ? proposeNear(text, tailPattern, head + quote.length - MAX_BITS, near, budget)
    : proposeFromStart(text, tailPattern, budget)
  const headFirst = whole(wholeAt(text, quote, head, tail, budget))
  if (headFirst) return headFirst
  // A tail that `match` could not place may still be there, differing more than
  // an end alone may: the whole is judged over a window the quote's length from
  // the head, not by whether its last 32 characters match.
  const fromHead = head === -1 ? null : whole(regionAt(text, quote, head, head + quote.length + 16, budget))
  if (fromHead) return fromHead

  // The first head may be boilerplate that repeats, with the passage later. So
  // the tail from the start, and the head near where it would be before it.
  const tailFirst = head === -1 ? tail : proposeFromStart(text, tailPattern, budget)
  const headNear = tailFirst === -1 ? -1 : proposeNear(text, headPattern, tailFirst - (quote.length - MAX_BITS), near, budget)
  const fromTail = whole(wholeAt(text, quote, headNear, tailFirst, budget))
  if (fromTail) return fromTail
  const endingAtTail = tailFirst === -1 ? null : whole(regionAt(text, quote, tailFirst + MAX_BITS + 8 - quote.length - 16, tailFirst + MAX_BITS + 8, budget))
  if (endingAtTail) return endingAtTail
  // A whole that was alike but for its numbers, and nothing better: not this
  // passage, and no anchor near it either.
  if (numbersDiffered) return null

  // Only an end matched, or the whole was not alike enough: the passage is near
  // here, and no more is known. The head is the better anchor, being where a
  // reader starts. An end whose numbers differ is not this passage.
  const headAnchor = anchorAt(text, headPattern, head, budget)
  if (headAnchor) {
    const region = text.slice(head, head + headWords(quote).length + 12)
    return numbersAgree(headWords(quote), region) ? { status: 'anchored', at: headAnchor } : null
  }
  const tailAnchor = anchorAt(text, tailPattern, tailFirst, budget)
  if (tailAnchor) {
    const region = text.slice(Math.max(0, tailFirst - 12), tailFirst + MAX_BITS + 12)
    return numbersAgree(tailWords(quote), region) ? { status: 'anchored', at: tailAnchor } : null
  }
  return null
}

type Resolution = { status: ClaimSourceStatus; at?: Span; matched?: string }

/**
 * Resolve one quote exactly or normalized, which every item gets: a resolution,
 * or the normalized quote when it takes a fuzzy search to say.
 */
function resolveDirectly(quote: string, doc: string, normDoc: () => Norm): Resolution | { search: string } {
  if (quote.trim().length === 0) return { status: 'ungrounded' }

  const exact = doc.indexOf(quote)
  if (exact !== -1) return found('exact', doc, { start: exact, end: exact + quote.length })

  const nq = trimEnd(normalize(quote, { tags: true, fold: true }))
  if (nq.s.length === 0) return { status: 'ungrounded' }
  const nd = normDoc()
  const normalized = nd.s.indexOf(nq.s)
  if (normalized !== -1) return found('normalized', doc, original(nd, normalized, normalized + nq.s.length))

  return nq.s.length > MAX_FUZZY_QUOTE ? { status: 'ungrounded' } : { search: nq.s }
}

/** A resolved result: the range, and the passage as a reader sees it. */
function found(status: ClaimSourceStatus, doc: string, at: Span): { status: ClaimSourceStatus; at: Span; matched: string } {
  return { status, at, matched: trimEnd(normalize(doc.slice(at.start, at.end), { tags: true, fold: false })).s }
}

/**
 * Resolve a bill's claim sources against the summary it stores and the document
 * its analysis read (`billHtmlToText` of the pinned document), or null for a PDF.
 *
 * - An item whose claim isn't in the summary, exact or with whitespace
 *   normalized, can never be shown and is dropped, and counted in `dropped`.
 * - A PDF's quote is `unverified`: the instance extracts no PDF text, so the
 *   link goes by the cited page. An empty quote is `ungrounded` either way.
 * - Where two passages are alike, the first is the one found, every time.
 * - At most 100 items are resolved (the rest are `ungrounded`, counted in
 *   `capped`), and every one is searched exactly and normalized. A quote over
 *   2,000 characters goes no further. The fuzzy searches share one work
 *   budget, cheapest first, and an item it could not finish is `ungrounded`,
 *   counted in `unsearched`. See `MAX_ITEMS` and `WORK_BUDGET`.
 */
export function resolveClaimSources(
  items: readonly ClaimSource[],
  summary: string,
  docText: string | null,
): { items: ResolvedClaimSource[]; dropped: number; capped: number; unsearched: number } {
  const out: ResolvedClaimSource[] = []
  let dropped = 0
  let capped = 0
  let searched = 0
  let normDoc: Norm | null = null
  const getNormDoc = () => (normDoc ??= normalize(docText ?? '', { tags: true, fold: true }))
  const withResult = (item: ResolvedClaimSource, r: Resolution): ResolvedClaimSource =>
    r.at ? { ...item, status: r.status, quoteAt: r.at, matched: r.matched } : { ...item, status: r.status }
  const budget: Budget = { left: WORK_BUDGET, skipped: 0, docFactor: 1, exactAt: new Map() }
  /** The items a fuzzy search must settle: where each is in `out`, its normalized quote, and what its first call costs. */
  const pending: { index: number; quote: string; cost: number }[] = []
  for (const item of items) {
    const claimAt = findClaim(summary, item.claim)
    if (!claimAt) { dropped++; continue }
    if (docText === null) {
      out.push({ ...item, status: item.quote.trim().length === 0 ? 'ungrounded' : 'unverified', claimAt })
      continue
    }
    if (searched >= MAX_ITEMS) {
      capped++
      out.push({ ...item, status: 'ungrounded', claimAt })
      continue
    }
    searched++
    const r = resolveDirectly(item.quote, docText, getNormDoc)
    if ('search' in r) {
      out.push({ ...item, status: 'ungrounded', claimAt })
      pending.push({ index: out.length - 1, quote: r.search, cost: matchCost(getNormDoc().s, firstPattern(r.search), budget) })
    } else {
      out.push(withResult({ ...item, status: r.status, claimAt }, r))
    }
  }

  // Cheapest first, and in order among equals (the sort is stable): a quote
  // whose head is in the document exactly costs a fraction of a scan and is
  // likely found, and one that is absent costs two whole scans for nothing.
  // The document's width scales every cost alike, so it is counted once, after.
  pending.sort((a, b) => a.cost - b.cost)
  if (pending.length > 0) budget.docFactor = widthFactor(getNormDoc().s)
  for (const { index, quote } of pending) {
    // Only an item with a document has a search pending.
    const nd = getNormDoc()
    const fuzzy = findFuzzy(nd.s, quote, budget)
    if (fuzzy) out[index] = withResult(out[index], found(fuzzy.status, docText ?? '', original(nd, fuzzy.at.start, fuzzy.at.end)))
  }
  return { items: out, dropped, capped, unsearched: budget.skipped }
}

/**
 * The claim sources still true of an edited summary: those whose claim is still
 * found in it, each with its claim's new place. Everything else about an item
 * stays, since the quote and the document it was resolved against haven't changed.
 */
export function pruneClaimSources(items: readonly ResolvedClaimSource[], summary: string | null): ResolvedClaimSource[] {
  if (summary === null) return []
  const out: ResolvedClaimSource[] = []
  for (const item of items) {
    const claimAt = typeof item?.claim === 'string' ? findClaim(summary, item.claim) : null
    if (claimAt) out.push({ ...item, claimAt })
  }
  return out
}
