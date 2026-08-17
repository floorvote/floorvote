import { eq } from 'drizzle-orm'
import { associationConfig } from '../db/schema'
import type { AppDb } from '../types'

export type TaxonomyItem = { name: string; description?: string }

export function parseTaxonomyItems(raw: unknown): TaxonomyItem[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap(item => {
    if (typeof item === 'string' && item) return [{ name: item }]
    if (typeof item === 'object' && item !== null && typeof (item as Record<string, unknown>).name === 'string') {
      const { name, description } = item as { name: string; description?: string }
      return description ? [{ name, description }] : [{ name }]
    }
    return []
  })
}

export const DEFAULT_TAXONOMY: TaxonomyItem[] = [
  { name: 'Health & Healthcare' },
  { name: 'Education' },
  { name: 'Elections & Voting' },
  { name: 'Housing & Land Use' },
  { name: 'Transportation & Infrastructure' },
  { name: 'Environment & Natural Resources' },
  { name: 'Criminal Justice & Public Safety' },
  { name: 'Taxation & Revenue' },
  { name: 'Labor & Employment' },
  { name: 'Business & Economic Development' },
  { name: 'Social Services & Human Services' },
  { name: 'Courts & Civil Procedure' },
  { name: 'State Government & Administration' },
  { name: 'Local Government' },
  { name: 'Agriculture & Rural Affairs' },
]

/**
 * The tenant's effective tag taxonomy: the configured list, or DEFAULT_TAXONOMY when
 * unset/empty/malformed. Mirrors the resolution rule in api/src/queue/processor.ts so the
 * write path (what tags the AI may assign) and every read/display path share one definition
 * of "valid tags".
 */
export async function loadEffectiveTaxonomy(db: AppDb): Promise<TaxonomyItem[]> {
  const row = await db.select().from(associationConfig)
    .where(eq(associationConfig.key, 'tag_taxonomy')).get()
  let parsed: TaxonomyItem[] = []
  if (row) {
    try { parsed = parseTaxonomyItems(JSON.parse(row.value)) } catch { parsed = [] }
  }
  return parsed.length > 0 ? parsed : DEFAULT_TAXONOMY
}

/** Set of valid tag NAMES for the tenant's effective taxonomy. */
export async function loadTaxonomyTagNameSet(db: AppDb): Promise<Set<string>> {
  return new Set((await loadEffectiveTaxonomy(db)).map(t => t.name))
}

/** Drop any tag not present in `allowed` (exact string membership). Pure. */
export function filterTagsToTaxonomy(tags: string[], allowed: Set<string>): string[] {
  return tags.filter(t => allowed.has(t))
}
