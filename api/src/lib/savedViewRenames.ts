import { BILL_FILTER_DEFS, CUSTOM_FIELD_KEY_PREFIX, parseBillFilter, serializeBillFilter, withBillFilter } from '../../../shared/billFilter'

// A saved view stores a bill filter's query string, and a custom field is named in it by `field.<slug>` with
// its dropdown options as the values. When an admin renames a field or one of its options, the views that
// filter on the old name are rewritten here, through the shared parse and serialize rather than by editing the
// string, so every key and value is read and written the way the Bills page does.

export type OptionRename = Readonly<{ from: string; to: string }>

/**
 * The `renames` of an options edit, checked against the options before and after: a list of `{ from, to }`
 * where each `from` was an old option, each `to` is a new one, no `from` or `to` repeats, and none renames
 * an option to itself. A chain (a to b, b to c) is refused. A swap (a to b, b to a) is allowed: every value
 * of a view is mapped once, so the two do not cascade. An error message, or the renames.
 */
export function validateOptionRenames(input: unknown, before: readonly string[], after: readonly string[]): { renames: OptionRename[] } | { error: string } {
  if (input === undefined) return { renames: [] }
  if (!Array.isArray(input)) return { error: 'renames must be an array of { from, to }' }
  const renames: OptionRename[] = []
  for (const entry of input) {
    if (!entry || typeof entry !== 'object' || typeof (entry as OptionRename).from !== 'string' || typeof (entry as OptionRename).to !== 'string') {
      return { error: 'each rename must be { from, to } with text values' }
    }
    const { from, to } = entry as OptionRename
    if (from === to) return { error: `rename of "${from}" to itself` }
    if (!before.includes(from)) return { error: `rename from "${from}", which is not an existing option` }
    if (!after.includes(to)) return { error: `rename to "${to}", which is not in the new options` }
    renames.push({ from, to })
  }
  if (new Set(renames.map(r => r.from)).size !== renames.length) return { error: 'an option is renamed more than once' }
  if (new Set(renames.map(r => r.to)).size !== renames.length) return { error: 'two options are renamed to the same value' }
  for (const r of renames) {
    const next = renames.find(o => o.from === r.to)
    if (next && next.to !== r.from) return { error: `rename chain through "${r.to}"` }
  }
  return { renames }
}

export type ViewRename = Readonly<{
  /** The field's slug before, and the slug it has now. Equal when only its options changed. */
  fromSlug: string
  toSlug: string
  /** The renamed options of the field. */
  options: readonly OptionRename[]
}>

/** The query rewritten for the rename, or null when the view does not filter on the field and so stays as it is. */
export function rewriteViewQuery(query: string, rename: ViewRename): string | null {
  const filter = parseBillFilter(query)
  const fromValues = filter.field[rename.fromSlug]
  if (!fromValues) return null

  const field: Record<string, readonly string[]> = { ...filter.field }
  delete field[rename.fromSlug]

  const renamed = new Map(rename.options.map(o => [o.from, o.to]))
  const moved = fromValues.map(v => renamed.get(v) ?? v)
  // A filter already on the new key (a stale one for a field that was deleted) keeps its values, and the moved ones join them.
  const existing = rename.toSlug === rename.fromSlug ? [] : (field[rename.toSlug] ?? [])
  field[rename.toSlug] = [...new Set([...existing, ...moved])]

  // The filter is written by serialize. What a view holds besides the filter (its sort and dir, or any key the filter
  // does not own) is not parsed, so it is carried over as it was.
  const owned = new Set(BILL_FILTER_DEFS.map(d => d.name as string))
  const rest = new URLSearchParams()
  for (const [key, value] of new URLSearchParams(query)) {
    if (!owned.has(key) && !key.startsWith(CUSTOM_FIELD_KEY_PREFIX)) rest.append(key, value)
  }
  const kept = rest.toString()
  const filterPart = serializeBillFilter(withBillFilter({ field }, filter))
  const next = kept === '' ? filterPart : filterPart === '' ? kept : `${filterPart}&${kept}`
  return next === query ? null : next
}


/**
 * The statements that move the stored bill values of a dropdown field along with its renamed options: one for a
 * single-select value (a bare string) and one for a multi-select value (a JSON array, each element mapped once,
 * a repeat dropped). Each value goes through one CASE, so a swap does not cascade. Bind `[from, to, ...]` pairs
 * and then `fieldId` and the `from` values, in the order the SQL reads them.
 */
export function billValueRenameStatements(fieldId: string, renames: readonly OptionRename[]): { sql: string; params: string[] }[] {
  if (renames.length === 0) return []
  const cases = renames.map(() => 'WHEN ? THEN ?').join(' ')
  const pairs = renames.flatMap(r => [r.from, r.to])
  const froms = renames.map(r => r.from)
  const marks = froms.map(() => '?').join(', ')
  return [
    {
      sql: `UPDATE bill_custom_field_values SET value = CASE value ${cases} ELSE value END WHERE field_id = ? AND value IN (${marks})`,
      params: [...pairs, fieldId, ...froms],
    },
    {
      sql: `UPDATE bill_custom_field_values SET value = (SELECT json_group_array(DISTINCT CASE je.value ${cases} ELSE je.value END) FROM json_each(bill_custom_field_values.value) je)
        WHERE field_id = ? AND json_valid(value) = 1 AND json_type(value) = 'array'
          AND EXISTS (SELECT 1 FROM json_each(bill_custom_field_values.value) je WHERE je.value IN (${marks}))`,
      params: [...pairs, fieldId, ...froms],
    },
  ]
}
