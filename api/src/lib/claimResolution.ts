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
function align(quote: string, region: string): { similarity: number; start: number; end: number } {
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
 * The fuzzy search's budget for one bill, in characters scanned: each `match`
 * call scans the whole document, and a quote that is absent costs two of them
 * (about 0.2 s on half a million characters, 0.6 s on 1.7 million). About 40
 * million is around ten seconds of scanning, well inside a Worker's CPU limit.
 * A quote that is found stops early and costs far less, so it is charged only
 * `FOUND_COST` of a scan (an eighth), and a bill whose quotes mostly resolve
 * never runs out. What bounds the work is quotes that are absent from a very
 * large document. A quote that needs a scan after the budget is spent stays
 * ungrounded.
 */
const SCAN_BUDGET = 40_000_000
const FOUND_COST = 1 / 8

type Budget = { left: number; skipped: number }

/** What must agree between a quote and what is found for it: digits, cardinal and ordinal words, and fractions. */
const CARDINALS = 'zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion'
const ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth', 'eleventh', 'twelfth', 'thirteenth', 'fourteenth', 'fifteenth', 'sixteenth', 'seventeenth', 'eighteenth', 'nineteenth', 'twentieth']
// "1st" is one token, so its digit isn't read as a number of its own. An ordinal
// word takes a plural for a fraction ("two thirds").
const NUMBER = new RegExp(`\\b\\d+(?:st|nd|rd|th)\\b|\\d+(?:[.,]\\d+)*|\\b(?:(?:${ORDINALS.join('|')})s?|${CARDINALS}|half|halves|quarters?)\\b`, 'gi')

/** One number as a token that the same number written another way shares: "first" and "1st" are `1o`. */
function numberToken(raw: string): string {
  const t = raw.toLowerCase()
  const digitOrdinal = /^(\d+)(?:st|nd|rd|th)$/.exec(t)
  if (digitOrdinal) return `${Number(digitOrdinal[1])}o`
  const ordinal = ORDINALS.indexOf(t.endsWith('s') && ORDINALS.includes(t.slice(0, -1)) ? t.slice(0, -1) : t)
  if (ordinal !== -1) return `${ordinal + 1}o`
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

/** Between two characters of a number or word that a line break can fall inside: a hyphen or separator, the break, and a line number. */
const BREAK = '(?:[-,.]?\\s+(?:\\d{1,3}\\s+)?)?'

/** Whether a number is in the text, written with a line break (and its line number) inside it. */
function brokenIn(raw: string, text: string): boolean {
  const spelled = [...raw].map(c => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join(BREAK)
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

/** Where `match` puts a pattern, or -1. It only proposes: `makeDiff` decides. */
function propose(text: string, pattern: string, expected: number, distance: number, budget: Budget): number {
  budget.left -= text.length
  return match(text, pattern, expected, { threshold: ERROR_BUDGET + POSITION_BUDGET, distance })
}

/**
 * A quote's end (its first or last 32 characters), which `match` placed at
 * `at`: the range it covers if it is alike enough, else null.
 */
function anchorAt(text: string, pattern: string, at: number): Span | null {
  if (at === -1) return null
  const scored = align(pattern, text.slice(at, at + pattern.length + 8))
  return scored.similarity >= MIN_SIMILARITY ? { start: at + scored.start, end: at + scored.end } : null
}

/** The region `[from, to)` of the text, scored against the whole quote, or null when it is not alike enough. */
function regionAt(text: string, quote: string, from: number, to: number): Span | null {
  const start = Math.max(0, from)
  const scored = align(quote, text.slice(start, to))
  return scored.similarity >= MIN_SIMILARITY ? { start: start + scored.start, end: start + scored.end } : null
}

/** The whole region from a head to a tail, or null when either is missing or the tail is not after the head. */
function wholeAt(text: string, quote: string, head: number, tail: number): Span | null {
  if (head === -1 || tail === -1 || tail <= head) return null
  return regionAt(text, quote, head, tail + MAX_BITS + 8)
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
  if (quote.length > MAX_FUZZY_QUOTE) return null
  if (budget.left <= 0) { budget.skipped++; return null }
  const before = budget.left
  const result = searchFuzzy(text, quote, budget)
  // Found, it stopped early: charge for that, not for the scans a miss makes.
  if (result) budget.left = before - Math.ceil(text.length * FOUND_COST)
  return result
}

function searchFuzzy(text: string, quote: string, budget: Budget): Fuzzy | null {

  // Wide enough that a match at the far end of the text costs at most
  // POSITION_BUDGET, so the document is searched from the start (the first of
  // two identical passages scores a hair better, which makes it the one found).
  const wide = Math.max(1000, Math.ceil(text.length / POSITION_BUDGET))

  if (quote.length <= MAX_BITS) {
    // No separate head and tail: the whole quote is the pattern.
    const at = propose(text, quote, 0, wide, budget)
    const span = anchorAt(text, quote, at)
    return span && numbersAgree(quote, text.slice(span.start, span.end)) ? { status: 'fuzzy', at: span } : null
  }

  const headPattern = quote.slice(0, MAX_BITS)
  const tailPattern = quote.slice(-MAX_BITS)
  const near = Math.max(1000, 2 * quote.length)
  // undefined: no whole region was alike enough, so keep looking. null: one was,
  // but its numbers disagree, so it is not this passage.
  const whole = (span: Span | null): Fuzzy | null | undefined =>
    span === null ? undefined : numbersAgree(quote, text.slice(span.start, span.end)) ? { status: 'fuzzy', at: span } : null

  // The head from the start of the document, then the tail near where it would
  // be if the passage were whole, as the library's `applyPatches` does.
  const head = propose(text, headPattern, 0, wide, budget)
  const tail = head !== -1
    ? propose(text, tailPattern, head + quote.length - MAX_BITS, near, budget)
    : propose(text, tailPattern, 0, wide, budget)
  const headFirst = whole(wholeAt(text, quote, head, tail))
  if (headFirst !== undefined) return headFirst
  // A tail that `match` could not place may still be there, differing more than
  // an end alone may: the whole is judged over a window the quote's length from
  // the head, not by whether its last 32 characters match.
  const fromHead = head === -1 ? undefined : whole(regionAt(text, quote, head, head + quote.length + 16))
  if (fromHead !== undefined) return fromHead

  // The first head may be boilerplate that repeats, with the passage later. So
  // the tail from the start, and the head near where it would be before it.
  const tailFirst = head === -1 ? tail : propose(text, tailPattern, 0, wide, budget)
  const headNear = tailFirst === -1 ? -1 : propose(text, headPattern, tailFirst - (quote.length - MAX_BITS), near, budget)
  const fromTail = whole(wholeAt(text, quote, headNear, tailFirst))
  if (fromTail !== undefined) return fromTail
  const endingAtTail = tailFirst === -1 ? undefined : whole(regionAt(text, quote, tailFirst + MAX_BITS + 8 - quote.length - 16, tailFirst + MAX_BITS + 8))
  if (endingAtTail !== undefined) return endingAtTail

  // Only an end matched, or the whole was not alike enough: the passage is near
  // here, and no more is known. The head is the better anchor, being where a
  // reader starts. An end whose numbers differ is not this passage.
  const headAnchor = anchorAt(text, headPattern, head)
  if (headAnchor) {
    const region = text.slice(head, head + headWords(quote).length + 12)
    return numbersAgree(headWords(quote), region) ? { status: 'anchored', at: headAnchor } : null
  }
  const tailAnchor = anchorAt(text, tailPattern, tailFirst)
  if (tailAnchor) {
    const region = text.slice(Math.max(0, tailFirst - 12), tailFirst + MAX_BITS + 12)
    return numbersAgree(tailWords(quote), region) ? { status: 'anchored', at: tailAnchor } : null
  }
  return null
}

/** Resolve one quote against the document the model read. */
function resolveQuote(
  quote: string,
  doc: string,
  normDoc: () => Norm,
  budget: Budget,
): { status: ClaimSourceStatus; at?: Span; matched?: string } {
  if (quote.trim().length === 0) return { status: 'ungrounded' }

  const exact = doc.indexOf(quote)
  if (exact !== -1) return found('exact', doc, { start: exact, end: exact + quote.length })

  const nq = trimEnd(normalize(quote, { tags: true, fold: true }))
  if (nq.s.length === 0) return { status: 'ungrounded' }
  const nd = normDoc()
  const normalized = nd.s.indexOf(nq.s)
  if (normalized !== -1) return found('normalized', doc, original(nd, normalized, normalized + nq.s.length))

  const fuzzy = findFuzzy(nd.s, nq.s, budget)
  if (!fuzzy) return { status: 'ungrounded' }
  return found(fuzzy.status, doc, original(nd, fuzzy.at.start, fuzzy.at.end))
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
 *   `capped`), a quote over 2,000 characters is only searched exactly and
 *   normalized, and the fuzzy searches share one scan budget (what it left
 *   unsearched is counted in `unsearched`). See `MAX_ITEMS` and `SCAN_BUDGET`.
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
  const budget: Budget = { left: SCAN_BUDGET, skipped: 0 }
  let normDoc: Norm | null = null
  const getNormDoc = () => (normDoc ??= normalize(docText ?? '', { tags: true, fold: true }))
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
    const r = resolveQuote(item.quote, docText, getNormDoc, budget)
    out.push(r.at ? { ...item, status: r.status, claimAt, quoteAt: r.at, matched: r.matched } : { ...item, status: r.status, claimAt })
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
