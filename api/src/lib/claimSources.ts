import { and, eq } from 'drizzle-orm'
import { associationConfig, billTexts, bills } from '../db/schema'
import type { AppDb } from '../types'

// Claim sources (#568, design in #560): for each claim in an AI summary, a
// short quote from the bill text that supports it, so a reader can go from the
// claim to the passage. The analysis call asks for them through its response
// schema (lib/llm.ts), and the bill stores them pinned to the document the
// model read (queue/processor.ts, migrations/0108_claim_sources.sql).
//
// Not `citations`: that word, and `affectedCitations`, already mean the
// statutory citations a bill affects.

/** Which input the model read, which decides an item's shape. */
export type ClaimSourceInput = 'html' | 'pdf'

/**
 * One claim and its quote, verbatim as the model returned them. `page` is set
 * only for a PDF: the page of the file the quote is on, counting from 1, or
 * null when the model gave no usable page.
 */
export type ClaimSource = { claim: string; quote: string; page?: number | null }

/**
 * How a claim source's quote resolved against the document it was pinned to
 * (lib/claimResolution.ts):
 *
 * - `exact`: found character for character.
 * - `normalized`: found after folding whitespace, curly quotes and dashes, and
 *   ignoring the retained redline markup. A whitespace-only difference is this
 *   too: the instance can't tell the two apart in a way a reader would care about.
 * - `fuzzy`: found by `@sanity/diff-match-patch` at similarity 0.8 or more,
 *   which is how a faithful copy broken by line numbers or a running header
 *   inside the span resolves.
 * - `anchored`: only the first or last 32 characters of a long quote matched.
 *   The location is that anchor, which is near the passage but isn't all of it.
 * - `ungrounded`: not found, or the quote was empty.
 * - `unverified`: a PDF's quote. The instance extracts no PDF text, so the quote
 *   was never matched, and the link goes by the cited page instead (#572).
 */
export type ClaimSourceStatus = 'exact' | 'normalized' | 'fuzzy' | 'anchored' | 'ungrounded' | 'unverified'

/** A half-open character range `[start, end)`. */
export type Span = { start: number; end: number }

/**
 * A claim source after resolution, as stored in `bills.claim_sources`.
 *
 * - `claimAt`: where the claim is in the summary the bill stores.
 * - `quoteAt`: where the quote is in the pinned document, for an `exact`,
 *   `normalized`, `fuzzy`, or `anchored` item, and absent otherwise. Offsets are
 *   into `billHtmlToText(document)`, the text the model read, which is a
 *   function of the pinned document alone.
 * - `matched`: the passage at `quoteAt`, markup removed and whitespace
 *   collapsed, so a reader of the rendered page can look for it without
 *   reproducing `billHtmlToText`.
 */
export type ResolvedClaimSource = ClaimSource & {
  status: ClaimSourceStatus
  claimAt: Span
  quoteAt?: Span
  matched?: string
}

/** The `association_config` key holding the setting, a JSON boolean. Absent means on. */
export const CLAIM_LINKS_KEY = 'claim_links_enabled'

/**
 * The `association_config` key recording the last change to the setting, a JSON
 * `{ by, at }`: the admin's user id and a database timestamp. Written together
 * with the setting by `PUT /admin/claim-links` and by nothing else.
 */
export const CLAIM_LINKS_CHANGED_KEY = 'claim_links_changed'

/**
 * Whether this instance asks for claim sources, and shows their links. On by
 * default, so a new instance and an existing one with no row both read as on
 * until an admin turns it off (#570). Only a stored `false` is off: a row that
 * can't be read is the default rather than a silent switch-off.
 *
 * Off means new analyses don't ask, and store none. Links already stored are
 * left alone, and the bill page doesn't render them (#571, #572) until it is
 * turned back on.
 */
export async function claimLinksEnabled(db: AppDb): Promise<boolean> {
  const row = await db.select().from(associationConfig).where(eq(associationConfig.key, CLAIM_LINKS_KEY)).get()
  if (!row) return true
  try { return JSON.parse(row.value) !== false } catch { return true }
}

/**
 * Read the model's `claimSources` answer. Never throws: a missing, null, or
 * malformed answer degrades to an empty list, as `affectedCitations` does,
 * because the summary, tags, and score are the contract and this is extra.
 *
 * An item needs a non-blank string `claim` and a string `quote`, or it is
 * dropped. Strings are kept verbatim (claims are matched against the summary
 * character for character later). An empty quote is kept, so it can be counted
 * as ungrounded rather than lost. A PDF item's page must be a positive integer
 * or it becomes null, and an HTML item never carries one. Other fields are
 * dropped.
 */
export function parseClaimSources(raw: unknown, input: ClaimSourceInput): ClaimSource[] {
  if (!Array.isArray(raw)) return []
  const out: ClaimSource[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue
    const { claim, quote, page } = item as Record<string, unknown>
    if (typeof claim !== 'string' || claim.trim().length === 0) continue
    if (typeof quote !== 'string') continue
    out.push(input === 'pdf'
      ? { claim, quote, page: typeof page === 'number' && Number.isInteger(page) && page >= 1 ? page : null }
      : { claim, quote })
  }
  return out
}

/** A bill's stored claim sources, read for display: the items, and the document they are pinned to. */
export type StoredClaimSources = {
  /** The bill the claim sources are stored on: the one whose analysis they belong to. */
  billId: string
  /** The document the model read and the offsets are into. */
  docId: string
  textHash: string | null
  items: ResolvedClaimSource[]
}

const STATUSES: ReadonlySet<string> = new Set<ClaimSourceStatus>(['exact', 'normalized', 'fuzzy', 'anchored', 'ungrounded', 'unverified'])

const isSpan = (v: unknown): v is Span =>
  typeof v === 'object' && v !== null
  && Number.isInteger((v as Span).start) && Number.isInteger((v as Span).end)
  && (v as Span).start >= 0 && (v as Span).end >= (v as Span).start

/**
 * One stored item as a resolved claim source, or null when it isn't one. An
 * item from before resolution (#568 stored the model's answer as it came) has
 * no status, so it has no say in what a page shows.
 */
function readItem(raw: unknown): ResolvedClaimSource | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  if (typeof r.claim !== 'string' || typeof r.quote !== 'string') return null
  if (typeof r.status !== 'string' || !STATUSES.has(r.status) || !isSpan(r.claimAt)) return null
  const item: ResolvedClaimSource = { claim: r.claim, quote: r.quote, status: r.status as ClaimSourceStatus, claimAt: r.claimAt }
  if ('page' in r) item.page = typeof r.page === 'number' ? r.page : null
  if (isSpan(r.quoteAt)) item.quoteAt = r.quoteAt
  if (typeof r.matched === 'string') item.matched = r.matched
  return item
}

/**
 * The resolved claim sources in a `bills.claim_sources` value, or null when it
 * isn't a JSON list. An item that isn't a resolved claim source is left out.
 */
export function parseStoredItems(json: string): ResolvedClaimSource[] | null {
  let parsed: unknown
  try { parsed = JSON.parse(json) } catch { return null }
  if (!Array.isArray(parsed)) return null
  return parsed.map(readItem).filter((i): i is ResolvedClaimSource => i !== null)
}

/**
 * The claim sources stored on a bill, for display, or null when there is
 * nothing to show.
 *
 * `billId` is the bill whose analysis the page shows, never the page's own bill
 * when a companion group shows another member's analysis (the detail's
 * `teamValues.analysis.billId`). Its claim sources are pinned to that member's
 * document, and the check that the pinned document is still there is against
 * that member's texts too.
 *
 * Null when the bill has none stored, when what is stored isn't a list, and
 * when the pinned document is no longer in the bill's texts: the offsets are
 * into a document the reader can't open, so no link could land on them. The
 * stored items stay, for when the document is back.
 */
export async function readClaimSources(db: AppDb, billId: string): Promise<StoredClaimSources | null> {
  const row = await db.select({
    claimSources: bills.claimSources,
    docId: bills.claimSourcesDocId,
    textHash: bills.claimSourcesTextHash,
  }).from(bills).where(eq(bills.id, billId)).get()
  if (!row || row.claimSources === null || row.docId === null) return null

  const items = parseStoredItems(row.claimSources)
  if (items === null) return null

  // Only the document id is checked. The pin also holds the text hash the model
  // read, but an instance has no hash to compare it with: it stores `''` in
  // `bill_texts.text_hash` for every listed text, and central's text list carries
  // no per-document hash. A comparison would be dead code, or would read every
  // pin as stale. If that column is ever filled with the value central serves as
  // `textHash` for the document, compare it here, so a document whose content
  // changed under the same id stops reading until a re-analysis re-pins.
  const listed = await db.select({ id: billTexts.id }).from(billTexts)
    .where(and(eq(billTexts.billId, billId), eq(billTexts.docId, row.docId))).get()
  if (!listed) return null

  return {
    billId,
    docId: row.docId,
    textHash: row.textHash,
    items,
  }
}
