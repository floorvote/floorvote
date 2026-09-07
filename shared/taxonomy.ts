/**
 * The canonical tag taxonomy, and the one function that renders it for the
 * taxonomy editor.
 *
 * This list is the API's runtime fallback when a tenant's tag_taxonomy is
 * unset, empty, or malformed, AND the text the admin UI shows as the default.
 * It lived in two hand-synced copies until the Config page gained a "Start
 * from default" control: at that point a drifted copy stopped being a
 * misleading placeholder and started being written into a tenant's stored
 * config, so the copies were collapsed into this module.
 *
 * serializeTaxonomy is the single statement of the editor's wire format.
 * Three callers depend on it agreeing with itself: the Config page's loader
 * (building the saved-state snapshot from the rows it just loaded), the same
 * page's live projection of its rows to the string that snapshot is compared
 * against, and aiConfig's change-detection, which resolves a blank taxonomy to
 * this rendering of DEFAULT_TAXONOMY before deciding whether saving should
 * offer to reprocess every bill. If the separator were restated at any of
 * those sites, a seeded-but-unedited field would compare unequal to its own
 * default and every save would trigger a full-corpus reprocess.
 *
 * The editor itself is a table now, and rows — not this string — are its
 * canonical state; the string exists only as a comparison key and as the
 * parse target for stored text. Nothing round-trips rows through it.
 */
export type TaxonomyItem = { name: string; description?: string }

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
 * Render taxonomy entries as newline-delimited text.
 *
 * Entries are separated by a BLANK line, not a single newline: the rendering
 * dates from a textarea editor whose descriptions soft-wrapped, and
 * parseTagTaxonomy discards blank lines, so this round-trips through the
 * parser either way. This text never reaches the model, and no longer reaches
 * a user — saving sends the parsed array, not this string.
 */
export function serializeTaxonomy(items: TaxonomyItem[]): string {
  return items
    .map(t => (t.description ? `${t.name}: ${t.description}` : t.name))
    .join('\n\n')
}
