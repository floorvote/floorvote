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
