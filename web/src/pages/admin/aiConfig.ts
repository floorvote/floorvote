import { buildDefaultAiContext, buildDefaultRelevanceQuestion } from '../../../../shared/aiDefaults'
import { DEFAULT_TAXONOMY, serializeTaxonomy } from '../../../../shared/taxonomy'

export type TaxonomyEntry = { name: string; description?: string }

export type ParseResult =
  | { ok: true; value: TaxonomyEntry[] }
  | { ok: false; error: string }

/** Parse the newline-delimited "Name" / "Name: description" taxonomy editor text. */
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
  associationName: string
}

/**
 * Resolve the three AI-instruction fields to the text the model will actually
 * receive: a blank field falls back to its generic default, interpolated with
 * the association name that was in force alongside it.
 */
function resolveAiFields(f: AiInstructionFields) {
  return {
    aiContext: f.aiContext.trim() || buildDefaultAiContext(f.associationName),
    relevanceQuestion: f.relevanceQuestion.trim() || buildDefaultRelevanceQuestion(f.associationName),
    tagTaxonomy: f.tagTaxonomy.trim() || serializeTaxonomy(DEFAULT_TAXONOMY),
  }
}

/**
 * True if the EFFECTIVE AI instructions differ — the resolved prompt text, not
 * the raw editor contents. A true result offers the tenant a reprocess of every
 * bill, so raw comparison is wrong in both directions: seeding a blank field
 * with its own default changes the editor but not the prompt, and renaming the
 * association changes the prompt without touching any editor field.
 *
 * Each side resolves against the association name that accompanied it, which is
 * why the name is part of the compared shape rather than a separate argument.
 */
export function aiInstructionsChanged(a: AiInstructionFields, b: AiInstructionFields): boolean {
  const ra = resolveAiFields(a)
  const rb = resolveAiFields(b)
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
