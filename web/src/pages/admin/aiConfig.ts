import { buildDefaultAiContext, buildDefaultRelevanceQuestion } from '../../../../shared/aiDefaults'
import { DEFAULT_TAXONOMY, serializeTaxonomy } from '../../../../shared/taxonomy'

export type TaxonomyEntry = { name: string; description?: string }

export type ParseResult =
  | { ok: true; value: TaxonomyEntry[] }
  | { ok: false; error: string }

/**
 * Parse newline-delimited "Name" / "Name: description" taxonomy text — the
 * format serializeTaxonomy renders stored taxonomy into. Its single
 * production caller is resolveAiFields below, which parses that serialized
 * string back apart to compare the taxonomy actually sent to the model.
 * Nothing hand-writes or pastes taxonomy text through this function: the
 * table editor's paste path goes through parsePastedRows in taxonomyRows.ts
 * instead, and rows never round-trip through a string on their way in.
 */
export function parseTagTaxonomy(text: string): ParseResult {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean)
  const value: TaxonomyEntry[] = []
  for (const line of lines) {
    const colonIdx = line.indexOf(':')
    const name = colonIdx === -1 ? line.trim() : line.slice(0, colonIdx).trim()
    const description = colonIdx === -1 ? undefined : line.slice(colonIdx + 1).trim() || undefined
    if (!name) return { ok: false, error: 'Each tag must have a name before the colon.' }
    value.push(description ? { name, description } : { name })
  }
  return { ok: true, value }
}

export type AiInstructionFields = {
  aiContext: string
  relevanceQuestion: string
  tagTaxonomy: string
}

/**
 * Resolve the three AI-instruction fields to the text the model will actually
 * receive: a blank field falls back to its generic default, interpolated with
 * the given association name.
 *
 * The tag-taxonomy side compares the PARSED taxonomy (what is actually stored
 * and sent to the model), not the serialized string it arrives as —
 * reformatting a tag list (different line spacing, stray whitespace) changes
 * the string without changing the array it parses to, and that must not read
 * as a change. A malformed taxonomy (parseTagTaxonomy returns ok: false) falls
 * back to comparing the raw trimmed text, which is conservative but never
 * throws.
 */
function resolveAiFields(f: AiInstructionFields, associationName: string) {
  const taxonomyText = f.tagTaxonomy.trim() || serializeTaxonomy(DEFAULT_TAXONOMY)
  const parsed = parseTagTaxonomy(taxonomyText)
  return {
    aiContext: f.aiContext.trim() || buildDefaultAiContext(associationName),
    relevanceQuestion: f.relevanceQuestion.trim() || buildDefaultRelevanceQuestion(associationName),
    tagTaxonomy: parsed.ok ? taxonomyKey(parsed.value) : taxonomyText,
  }
}

/**
 * Comparison key for a parsed taxonomy: entries sorted by lowercased name
 * (then by description as a tiebreaker), so two lists holding the same tags
 * compare equal regardless of row order.
 *
 * Order is deliberately excluded. The taxonomy reaches the model as the `enum`
 * of the `tags` property under constrained decoding (buildAnalysisSchema), so
 * list position does not steer which tag it picks — reordering rows in the
 * editor is a tidiness affordance. Comparing order-sensitively here would make
 * a drag of the reorder grip offer to reprocess every bill in the tenant.
 *
 * The description takes part in the sort key because duplicate tag names are
 * permitted by design (the editor warns but does not block save), so the key
 * has to distinguish two entries that share a name — sorting on name alone
 * would let a stable sort preserve their original relative order, making a
 * mere swap of two same-named rows register as a change.
 *
 * Storage keeps editor order; only this comparison ignores it.
 */
function taxonomyKey(entries: TaxonomyEntry[]): string {
  return JSON.stringify(
    [...entries].sort((a, b) => {
      const byName = a.name.toLowerCase().localeCompare(b.name.toLowerCase())
      if (byName !== 0) return byName
      return (a.description ?? '').localeCompare(b.description ?? '')
    }),
  )
}

/**
 * True if the EFFECTIVE AI instructions differ — the resolved prompt content,
 * not the raw editor contents. A true result offers the tenant a reprocess of
 * every bill, so raw comparison is wrong: seeding a blank field with its own
 * default changes the editor text but not the prompt, and reformatting the tag
 * list without changing any tag changes the editor text but not the parsed
 * array actually sent to the model.
 *
 * Both sides resolve against the SAME associationName — the one currently in
 * force, i.e. the last-saved name, not a live-but-unsaved edit to the Labels
 * field. An unsaved name change is not yet in force for either side, so
 * comparing each side against a different name (or against an edit neither
 * side has actually saved) would produce false positives and false negatives
 * that have nothing to do with the AI-instruction fields this function is
 * meant to guard. A genuine rename is handled entirely by handleSaveLabels,
 * which never calls this function and never offers a reprocess.
 */
export function aiInstructionsChanged(
  a: AiInstructionFields,
  b: AiInstructionFields,
  associationName: string,
): boolean {
  const ra = resolveAiFields(a, associationName)
  const rb = resolveAiFields(b, associationName)
  return ra.aiContext !== rb.aiContext
    || ra.relevanceQuestion !== rb.relevanceQuestion
    || ra.tagTaxonomy !== rb.tagTaxonomy
}

/**
 * Full snapshot of every savable field on the Config page — what was last
 * loaded from the API or successfully written back to it. Used both by
 * aiInstructionsChanged (the ai-context/relevance/tags subset, for deciding
 * whether to offer a reprocess) and by the page's unsaved-changes dirty check
 * (all fields). Stores the raw, un-trimmed editor values (not the
 * trim()-on-save values sent to the API) so that a successful save — which
 * snapshots the field exactly as it stood in the editor at that moment —
 * immediately reads as clean, with no whitespace-trim mismatch.
 */
export type ConfigSnapshot = {
  keywords: string
  aiContext: string
  relevanceQuestion: string
  tagTaxonomy: string
  associationName: string
  orgNoun: string
  newMatchMinRelevance: number
}

/** True if any savable field differs from the snapshot. */
export function configChanged(a: ConfigSnapshot, b: ConfigSnapshot): boolean {
  return a.keywords !== b.keywords
    || a.aiContext !== b.aiContext
    || a.relevanceQuestion !== b.relevanceQuestion
    || a.tagTaxonomy !== b.tagTaxonomy
    || a.associationName !== b.associationName
    || a.orgNoun !== b.orgNoun
    || a.newMatchMinRelevance !== b.newMatchMinRelevance
}

/** Result of POST /admin/keyword-resync. */
export type KeywordResyncResult = {
  queued: number
  demoted: number
  protectedAsManual: number
  centralEnriched?: number
  centralTruncated?: boolean
  centralStatus?: 'ok' | 'rate_limited' | 'failed'
}

/**
 * Warning to show after a keyword sync, or null when the sync was fully healthy.
 *
 * The tenant-side pass and central's enrichment pass fail independently, and only
 * central can promote a stub to full analysis. A central failure therefore leaves
 * precisely the newly-matching stubs unanalyzed while the tenant-side count still
 * reports a plausible non-zero "queued" — which reads as success. Surfacing it is
 * the difference between noticing in seconds and auditing the database by hand.
 *
 * `centralStatus` is optional so a UI built against an older API (which omitted the
 * field) stays silent rather than warning on every save.
 */
export function centralSyncWarning(r: KeywordResyncResult): string | null {
  if (r.centralStatus === 'rate_limited') {
    return 'Central was rate-limited, so bills currently monitored as stubs were not upgraded. Wait a minute and save again.'
  }
  if (r.centralStatus === 'failed') {
    return 'Could not reach central, so bills currently monitored as stubs were not upgraded. Try saving again.'
  }
  if (r.centralTruncated) {
    return 'Too many new matches to process at once — save again to continue upgrading the rest.'
  }
  return null
}
