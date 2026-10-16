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

type Found = { start: number; end: number }

/** Where in `text` a quote of at most 32 characters, or the head or tail of a longer one, is found. */
function findWindow(text: string, pattern: string, expected: number, distance: number, slack: number): Found | null {
  const at = match(text, pattern, expected, { threshold: ERROR_BUDGET + POSITION_BUDGET, distance })
  if (at === -1) return null
  const region = text.slice(at, at + pattern.length + slack)
  const scored = align(pattern, region)
  return scored.similarity >= MIN_SIMILARITY ? { start: at + scored.start, end: at + scored.end } : null
}

/**
 * Fuzzy, anchored-only, or neither, for a quote that isn't there exactly or
 * after normalizing. Works on normalized text and returns a range of it.
 */
function findFuzzy(text: string, quote: string): { status: 'fuzzy' | 'anchored'; at: Found } | null {
  // Wide enough that a match at the far end of the text costs at most
  // POSITION_BUDGET, so the document is searched from the start (the first of
  // two identical passages scores a hair better, which makes it the one found).
  const wide = Math.max(1000, Math.ceil(text.length / POSITION_BUDGET))

  if (quote.length <= MAX_BITS) {
    // No separate head and tail: the whole quote is the pattern.
    const at = findWindow(text, quote, 0, wide, 12)
    return at ? { status: 'fuzzy', at } : null
  }

  const head = findWindow(text, quote.slice(0, MAX_BITS), 0, wide, 8)
  // The tail, near where it would be if the passage were whole, then scored
  // with the head as the library's `applyPatches` does: the tail has to come
  // after the head.
  const tailPattern = quote.slice(-MAX_BITS)
  const tail = head
    ? findWindow(text, tailPattern, head.start + quote.length - MAX_BITS, Math.max(1000, 2 * quote.length), 8)
    : findWindow(text, tailPattern, 0, wide, 8)

  if (head && tail && tail.end > head.end) {
    const region = text.slice(head.start, tail.end + 8)
    const scored = align(quote, region)
    if (scored.similarity >= MIN_SIMILARITY) {
      return { status: 'fuzzy', at: { start: head.start + scored.start, end: head.start + scored.end } }
    }
  }
  // Only an end matched, or the whole didn't: the passage is near here, and no
  // more is known. The head is the better anchor, being where a reader starts.
  const anchor = head ?? tail
  return anchor ? { status: 'anchored', at: anchor } : null
}

/** Resolve one quote against the document the model read. */
function resolveQuote(
  quote: string,
  doc: string,
  normDoc: () => Norm,
): { status: ClaimSourceStatus; at?: Span; matched?: string } {
  if (quote.trim().length === 0) return { status: 'ungrounded' }

  const exact = doc.indexOf(quote)
  if (exact !== -1) return found('exact', doc, { start: exact, end: exact + quote.length })

  const nq = trimEnd(normalize(quote, { tags: true, fold: true }))
  if (nq.s.length === 0) return { status: 'ungrounded' }
  const nd = normDoc()
  const normalized = nd.s.indexOf(nq.s)
  if (normalized !== -1) return found('normalized', doc, original(nd, normalized, normalized + nq.s.length))

  const fuzzy = findFuzzy(nd.s, nq.s)
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
 */
export function resolveClaimSources(
  items: readonly ClaimSource[],
  summary: string,
  docText: string | null,
): { items: ResolvedClaimSource[]; dropped: number } {
  const out: ResolvedClaimSource[] = []
  let dropped = 0
  let normDoc: Norm | null = null
  const getNormDoc = () => (normDoc ??= normalize(docText ?? '', { tags: true, fold: true }))
  for (const item of items) {
    const claimAt = findClaim(summary, item.claim)
    if (!claimAt) { dropped++; continue }
    if (docText === null) {
      out.push({ ...item, status: item.quote.trim().length === 0 ? 'ungrounded' : 'unverified', claimAt })
      continue
    }
    const r = resolveQuote(item.quote, docText, getNormDoc)
    out.push(r.at ? { ...item, status: r.status, claimAt, quoteAt: r.at, matched: r.matched } : { ...item, status: r.status, claimAt })
  }
  return { items: out, dropped }
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
