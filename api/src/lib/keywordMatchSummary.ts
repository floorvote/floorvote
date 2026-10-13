import { and, asc, eq, gt, sql } from 'drizzle-orm'
import { bills } from '../db/schema'
import { matchesKeywords, billMatchText } from './keywords'
import type { AppDb } from '../types'

export type KeywordMatchSummary = {
  /** Bills linked to the instance, analyzed or not. Member drafts are not counted. */
  total: number
  /** Bills the proposed list matches. */
  matched: number
  /** Bills the proposed list matches that the saved list does not. */
  newlyMatched: number
  /** Bills the saved list matches that the proposed list does not. */
  unmatched: number
}

// Rows per read. The matching runs here in JS, so every bill's title,
// description, and number crosses the D1 boundary. Reading in keyset pages
// keeps each response small and each query on the primary key.
const READ_BATCH = 2000

// How long a fetched corpus is reused. On the largest instance (about 93,000
// bills) one full read is 47 pages and takes seconds, and the summary is
// requested on every pause in typing, so a typing session must pay it once.
//
// TRADE-OFF: a count can lag the database by up to this long. A bill added or
// removed is noticed at once, because the cheap count(*) check below changes,
// but an edit to an existing bill's title or description (or an add paired
// with a remove) is not seen until the TTL runs out. Sync does that rarely
// enough that a minute of lag is invisible next to a count being typed against.
export const CORPUS_TTL_MS = 60_000

// The most characters of match text one instance may keep cached. The corpus
// lives in a 128 MB isolate next to everything else the Worker does. The
// largest instance holds about 31 million characters (93,000 bills), which at
// one byte per character is about 31 MB. Past this limit the corpus is not
// kept: calls answer by matching each page as it is read and dropping the
// page. Slower, but bounded in memory.
export const MAX_CACHED_CHARS = 40_000_000
let maxCachedChars = MAX_CACHED_CHARS

/** Lower the cache limit so a test can cross it without 40 million characters. */
export function setMaxCachedCharsForTest(n: number): void {
  maxCachedChars = n
}

// One entry per tenant, held for the life of the isolate. `texts` is null when
// the corpus was found too large to keep; that is remembered for the TTL so
// calls go straight to streaming instead of reading up to the limit again.
type Corpus = { loadedAt: number; texts: string[] | null }
const corpora = new Map<string, Corpus>()
// The cold read in progress, per tenant. Debounced requests that arrive while
// it runs wait on it instead of starting their own: each read builds a corpus
// of tens of megabytes, and several at once would not fit in the isolate.
const loading = new Map<string, Promise<string[] | null>>()
const warnedTooLarge = new Set<string>()

/** Drop every cached corpus. For tests, which reset the database under the cache. */
export function clearKeywordMatchCorpus(): void {
  corpora.clear()
  loading.clear()
  warnedTooLarge.clear()
  maxCachedChars = MAX_CACHED_CHARS
}

const FOLD_CHUNK = 8192

/**
 * What every character outside Latin-1 becomes in folded text. It must be a
 * character no keyword can contain, so a keyword can never match across the
 * place where one was. A space will not do: it is a legitimate keyword
 * character in every phrase, so "care access" would match "Care—Access" once
 * the dash had become a space. `isFoldSafe` rejects keywords containing it.
 */
const FOLD_SENTINEL = 1

/**
 * The text a bill is matched on, folded so V8 can hold it one byte per
 * character: lowercased, with every character outside Latin-1 replaced by
 * FOLD_SENTINEL. V8 stores a string as two bytes per character as soon as one
 * character needs it (a curly quote, an em-dash), and a replace or toLowerCase
 * over such a string stays two-byte even when nothing outside ASCII is left.
 * Only building the string from char codes yields a one-byte one, so that is
 * what this does. (Measured in Node. The Worker runtime is V8 too, but the
 * figure has not been checked there.)
 *
 * Matching on the folded text gives the same answer as matching on the raw text
 * for any keyword list where `isFoldSafe` holds for every keyword:
 *  - The matcher is case-insensitive (the `i` flag) and its token boundary is
 *    ASCII-only, so a non-Latin-1 character is never part of a token and the
 *    sentinel is as good a separator as it was. A keyword with ASCII or Latin-1
 *    characters cannot match inside one: the engine's case folding never maps a
 *    non-ASCII character onto an ASCII one (Kelvin sign, long s), nor onto a
 *    Latin-1 one except the two `isFoldSafe` rules out.
 *  - Characters are lowercased one at a time, and only within ASCII and
 *    Latin-1, because `toLowerCase` on the whole string would turn some
 *    non-Latin-1 characters into Latin-1 ones (the dotted capital I into `i`).
 *  - The two line separators the regex `.` refuses to cross (U+2028, U+2029)
 *    become a newline, not the sentinel, so a `*` still cannot span them.
 *    `isFoldSafe` rejects keywords containing a newline for the same reason.
 */
export function foldForMatch(text: string): string {
  let out = ''
  for (let start = 0; start < text.length; start += FOLD_CHUNK) {
    const end = Math.min(start + FOLD_CHUNK, text.length)
    const codes = new Array<number>(end - start)
    for (let i = start; i < end; i++) {
      const c = text.charCodeAt(i)
      if (c > 255) codes[i - start] = c === 0x2028 || c === 0x2029 ? 10 : FOLD_SENTINEL
      else if ((c >= 65 && c <= 90) || (c >= 192 && c <= 222 && c !== 215)) codes[i - start] = c + 32
      else codes[i - start] = c
    }
    out += String.fromCharCode.apply(null, codes)
  }
  return out
}

/**
 * True when matching this keyword against folded text cannot differ from
 * matching it against raw text: every character is Latin-1, none has an
 * upper-case form outside Latin-1 (`ÿ` and `µ`, which the `i` flag would match
 * against `Ÿ` and `Μ` in raw text, where folding has already replaced them),
 * and none is the sentinel or a line break, which folding writes into the text
 * where raw text had something else.
 */
export function isFoldSafe(keyword: string): boolean {
  for (let i = 0; i < keyword.length; i++) {
    const c = keyword.charCodeAt(i)
    if (c > 255 || c === FOLD_SENTINEL || c === 10 || c === 13) return false
    const upper = keyword[i].toUpperCase()
    for (let j = 0; j < upper.length; j++) if (upper.charCodeAt(j) > 255) return false
  }
  return true
}

/**
 * Trimmed, non-blank entries. A blank line must not turn `['*', '']` into a
 * list the matcher no longer reads as a lone `*`.
 */
export function cleanKeywords(keywords: string[]): string[] {
  return keywords.map(k => k.trim()).filter(k => k !== '')
}

/**
 * Walk every non-draft bill's raw match text, a page at a time, dropping each
 * page before the next is read so rows never pile up. `visit` returns true to
 * stop early.
 */
async function scanBills(db: AppDb, visit: (text: string) => boolean | void): Promise<void> {
  let cursor = ''
  for (;;) {
    const rows = await db
      .select({ id: bills.id, title: bills.title, abstract: bills.abstract, billNumber: bills.billNumber })
      .from(bills)
      .where(and(eq(bills.isDraft, false), gt(bills.id, cursor)))
      .orderBy(asc(bills.id))
      .limit(READ_BATCH)
      .all()
    for (const row of rows) {
      if (visit(billMatchText({ title: row.title, description: row.abstract, billNumber: row.billNumber }))) return
    }
    if (rows.length < READ_BATCH) return
    cursor = rows[rows.length - 1].id
  }
}

/** Read every bill into a folded corpus, or give up (null) once it passes the size limit. */
async function loadCorpus(db: AppDb, tenantKey: string): Promise<string[] | null> {
  const texts: string[] = []
  let chars = 0
  let tooLarge = false
  await scanBills(db, text => {
    chars += text.length
    if (chars > maxCachedChars) {
      tooLarge = true
      return true
    }
    texts.push(foldForMatch(text))
  })
  if (tooLarge) {
    corpora.set(tenantKey, { loadedAt: Date.now(), texts: null })
    if (!warnedTooLarge.has(tenantKey)) {
      warnedTooLarge.add(tenantKey)
      console.warn(`[keyword-match-summary] bill text exceeds ${maxCachedChars} characters, so it is not cached and every count re-reads the bills`)
    }
    return null
  }
  corpora.set(tenantKey, { loadedAt: Date.now(), texts })
  return texts
}

/**
 * The folded corpus, from the isolate's cache while it is fresh, else read once
 * (shared by every caller that arrives meanwhile). Fresh means younger than the
 * TTL and one entry per non-draft bill now, checked with an index-only count
 * (idx_bills_is_draft) that reads no bill rows. Null means the corpus is too
 * large to keep and the caller must stream.
 */
async function corpusFor(db: AppDb, tenantKey: string): Promise<string[] | null> {
  const inFlight = loading.get(tenantKey)
  if (inFlight) return inFlight

  const cached = corpora.get(tenantKey)
  if (cached && Date.now() - cached.loadedAt < CORPUS_TTL_MS) {
    if (cached.texts === null) return null
    const [{ n }] = await db
      .select({ n: sql<number>`count(*)` })
      .from(bills)
      .where(eq(bills.isDraft, false))
      .all()
    if (cached.texts.length === n) return cached.texts
    // Someone else may have started the read while the count ran.
    const started = loading.get(tenantKey)
    if (started) return started
  }

  // Drop the stale corpus first, so the old and new ones are never held at once.
  corpora.delete(tenantKey)
  const read = loadCorpus(db, tenantKey).finally(() => loading.delete(tenantKey))
  loading.set(tenantKey, read)
  return read
}

type Tally = { next: string[]; current: string[]; unchanged: boolean; summary: KeywordMatchSummary }

function tally(t: Tally, text: string): void {
  t.summary.total++
  const matchesNext = matchesKeywords(text, t.next)
  if (matchesNext) t.summary.matched++
  if (t.unchanged) return
  const matchesCurrent = matchesKeywords(text, t.current)
  if (matchesNext && !matchesCurrent) t.summary.newlyMatched++
  if (!matchesNext && matchesCurrent) t.summary.unmatched++
}

/**
 * How many bills a keyword list matches, and how that differs from the saved
 * list. Matches on the shared match text and makes no LegiScan or AI calls.
 * `tenantKey` scopes the corpus cache to one instance's database.
 *
 * The baseline for "newly" and "unmatched" is the matcher run over the saved
 * list, not each bill's stored match type: that is the set saving moves from.
 *
 * Keywords outside Latin-1 (a curly quote, a non-Latin script) cannot be
 * matched against the folded cache, so those calls stream the bills instead,
 * as do all calls once the corpus is too large to keep.
 */
export async function summarizeKeywordMatches(
  db: AppDb,
  tenantKey: string,
  proposed: string[],
  saved: string[],
): Promise<KeywordMatchSummary> {
  const next = cleanKeywords(proposed)
  const current = cleanKeywords(saved)
  const t: Tally = {
    next,
    current,
    // Identical lists cannot change any bill, so the second matcher pass is skipped.
    unchanged: next.length === current.length && next.every((k, i) => k === current[i]),
    summary: { total: 0, matched: 0, newlyMatched: 0, unmatched: 0 },
  }

  if (next.every(isFoldSafe) && current.every(isFoldSafe)) {
    const texts = await corpusFor(db, tenantKey)
    if (texts) {
      for (const text of texts) tally(t, text)
      return t.summary
    }
  }

  await scanBills(db, text => { tally(t, text) })
  return t.summary
}
