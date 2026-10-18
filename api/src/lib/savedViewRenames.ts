import { parseBillFilter, serializeBillFilter, withBillFilter } from '../../../shared/billFilter'

// A saved view stores a bill filter's query string, and a custom field is named in it by `field.<slug>` with
// its dropdown options as the values. When an admin renames a field or one of its options, the views that
// filter on the old name are rewritten here, through the shared parse and serialize rather than by editing the
// string, so every key and value is read and written the way the Bills page does.

export type OptionRename = Readonly<{ from: string; to: string }>

/**
 * The options a dropdown edit renamed. The edit sends the whole new list, so a rename is read off by position:
 * the lists are the same length, and an option at the same place changed to a value that neither list shared
 * before. A reorder, an add, or a delete is therefore never taken for a rename, whatever the lists look like.
 */
export function detectOptionRenames(before: readonly string[], after: readonly string[]): OptionRename[] {
  if (before.length !== after.length) return []
  const was = new Set(before)
  const is = new Set(after)
  const renames: OptionRename[] = []
  for (let i = 0; i < before.length; i++) {
    const from = before[i]
    const to = after[i]
    if (typeof from === 'string' && typeof to === 'string' && from !== to && !is.has(from) && !was.has(to)) {
      renames.push({ from, to })
    }
  }
  return renames
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

  const next = serializeBillFilter(withBillFilter({ field }, filter))
  return next === query ? null : next
}

