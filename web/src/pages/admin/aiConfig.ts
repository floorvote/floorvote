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

/** True if any of the three AI-instruction editor fields differ from the snapshot. */
export function aiInstructionsChanged(
  a: { aiContext: string; relevanceQuestion: string; tagTaxonomy: string },
  b: { aiContext: string; relevanceQuestion: string; tagTaxonomy: string },
): boolean {
  return a.aiContext !== b.aiContext
    || a.relevanceQuestion !== b.relevanceQuestion
    || a.tagTaxonomy !== b.tagTaxonomy
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
