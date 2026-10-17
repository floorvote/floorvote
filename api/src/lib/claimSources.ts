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
 * Whether this instance asks for claim sources. On by default.
 *
 * #570 makes this a per-instance setting admins can turn off. Until it does,
 * every instance reads as on. Off means new analyses don't ask, and store none.
 */
export async function claimLinksEnabled(_db: AppDb): Promise<boolean> {
  return true
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
