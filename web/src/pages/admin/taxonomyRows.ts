import type { TaxonomyItem } from '../../../../shared/taxonomy'

/**
 * One editable row of the tag taxonomy table.
 *
 * `description` is a plain string rather than `string | undefined` (which is
 * how TaxonomyItem stores it) because a controlled input cannot hold
 * undefined. The distinction is restored by rowsToTaxonomy on the way out.
 *
 * Rows — not the serialized string — are the editor's canonical state. The
 * string cannot represent a row that has a description and no name yet, which
 * is an ordinary intermediate state when someone tabs into the second column
 * first; round-tripping through it would delete what they are typing.
 */
export type TaxonomyRow = { name: string; description: string }

/** Not exported: nothing outside this module names a problem type; rowProblems' return type carries it. */
type RowProblem = 'Duplicate' | 'Needs a name'

export function rowsFromTaxonomy(items: TaxonomyItem[]): TaxonomyRow[] {
  return items.map(t => ({ name: t.name, description: t.description ?? '' }))
}

/** Rows as they are stored and sent: trimmed, nameless rows dropped, order kept. */
export function rowsToTaxonomy(rows: TaxonomyRow[]): TaxonomyItem[] {
  const out: TaxonomyItem[] = []
  for (const r of rows) {
    const name = r.name.trim()
    if (!name) continue
    const description = r.description.trim()
    out.push(description ? { name, description } : { name })
  }
  return out
}

/**
 * Per-row problems, keyed by row index. A row is only ever one of these, and
 * neither blocks Save — see the spec on why a duplicate cannot corrupt the
 * prompt and why a dropped nameless row needs to be announced rather than
 * prevented.
 */
export function rowProblems(rows: TaxonomyRow[]): Record<number, RowProblem> {
  const byName = new Map<string, number[]>()
  const out: Record<number, RowProblem> = {}

  rows.forEach((r, i) => {
    const key = r.name.trim().toLowerCase()
    if (key) {
      const seen = byName.get(key)
      if (seen) seen.push(i)
      else byName.set(key, [i])
    } else if (r.description.trim()) {
      // A wholly empty row is the one someone is about to type into, so it is
      // deliberately silent — only a stranded description earns a warning.
      out[i] = 'Needs a name'
    }
  })

  for (const idx of byName.values()) {
    if (idx.length < 2) continue
    for (const i of idx) out[i] = 'Duplicate'
  }
  return out
}

/**
 * Parse pasted text into rows: a single column, two tab-separated columns out
 * of a spreadsheet, or "Name: description" lines.
 *
 * Tab wins over colon when a line has both, so a pasted spreadsheet can carry
 * a name that itself contains a colon.
 */
export function parsePastedRows(text: string): TaxonomyRow[] {
  const out: TaxonomyRow[] = []
  for (const line of text.replace(/\r/g, '').split('\n')) {
    if (!line.trim()) continue
    let name: string
    let description: string
    if (line.includes('\t')) {
      const parts = line.split('\t')
      name = parts[0]
      description = parts.slice(1).join(' ')
    } else {
      const colon = line.indexOf(':')
      name = colon === -1 ? line : line.slice(0, colon)
      description = colon === -1 ? '' : line.slice(colon + 1)
    }
    name = name.trim()
    if (!name) continue
    out.push({ name, description: description.trim() })
  }
  return out
}

/** Always leave one empty row at the end so there is somewhere to type. */
export function withTrailingBlank(rows: TaxonomyRow[]): TaxonomyRow[] {
  const last = rows[rows.length - 1]
  if (last && !last.name.trim() && !last.description.trim()) return rows
  return [...rows, { name: '', description: '' }]
}

export function moveRow(rows: TaxonomyRow[], from: number, to: number): TaxonomyRow[] {
  if (from < 0 || to < 0 || from >= rows.length || to >= rows.length || from === to) return rows
  const next = [...rows]
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved)
  return next
}
