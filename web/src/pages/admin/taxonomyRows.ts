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

export type SortDirection = 'asc' | 'desc'

/** Whether a row is wholly empty: no name and no description. */
function isBlank(row: TaxonomyRow): boolean {
  return !row.name.trim() && !row.description.trim()
}

/**
 * Sort `displayed` (including its trailing blank, if it has one) by name.
 *
 * Case-insensitive, comparing lowercased names with localeCompare — matching
 * how rowProblems already matches duplicates, so `elections` and `Elections`
 * sort together and land adjacent when they collide. Stable, so two rows
 * sharing a name keep their relative order.
 *
 * The last row is pinned out of the sort ONLY when it is actually blank (no
 * name and no description) — that is the trailing blank withTrailingBlank
 * adds, which is never a tag and always stays last. A real tag that happens
 * to be last is sorted like any other row; nothing about position alone
 * exempts it. Nameless-but-not-blank rows (no trailing blank, but no name
 * either — e.g. an orphaned description) sink to just above the pinned
 * blank rather than sorting to the top on an empty string, so a row flagged
 * "Needs a name" isn't catapulted to position 1.
 *
 * Returns the SAME array reference when the sort is a no-op, mirroring the
 * contract moveRow already uses, so a caller can skip onChange/dirtying.
 */
export function sortRows(rows: TaxonomyRow[], direction: SortDirection): TaxonomyRow[] {
  if (rows.length === 0) return rows
  const lastIndex = rows.length - 1
  const lastRow = rows[lastIndex]
  const pinBlank = isBlank(lastRow)
  const blank = pinBlank ? lastRow : null
  const rest = pinBlank ? rows.slice(0, lastIndex) : rows

  const indexed = rest.map((row, i) => ({ row, i }))
  indexed.sort((a, b) => {
    const aName = a.row.name.trim()
    const bName = b.row.name.trim()
    // Nameless rows sink to the bottom (just above the pinned trailing
    // blank, if any), regardless of direction, rather than sorting to the
    // top on ''.
    if (!aName && !bName) return a.i - b.i
    if (!aName) return 1
    if (!bName) return -1
    const cmp = aName.toLowerCase().localeCompare(bName.toLowerCase())
    if (cmp !== 0) return direction === 'asc' ? cmp : -cmp
    return a.i - b.i
  })

  const sorted = indexed.map(({ row }) => row)
  const next = blank ? [...sorted, blank] : sorted
  const unchanged = next.every((row, i) => row === rows[i])
  return unchanged ? rows : next
}

/**
 * The sort direction the given rows are ALREADY in, derived from the rows
 * themselves rather than tracked as separate state — so it can never go
 * stale after an Undo, a Reset, or rows handed in fresh from a reload.
 *
 * Counts "real" rows the same way sortRows does: every row is real except a
 * genuinely blank last row (no name, no description), which is never a tag.
 * This does NOT assume a trailing blank is present — a caller (or a unit
 * test) that hands in rows with no trailing blank at all still gets every
 * row counted. With fewer than two real rows the order is ambiguous, so the
 * result is 'none'.
 */
export function deriveSortDirection(displayed: TaxonomyRow[]): 'none' | SortDirection {
  const last = displayed[displayed.length - 1]
  const realRowCount = last && isBlank(last) ? displayed.length - 1 : displayed.length
  if (realRowCount < 2) return 'none'
  if (sortRows(displayed, 'asc') === displayed) return 'asc'
  if (sortRows(displayed, 'desc') === displayed) return 'desc'
  return 'none'
}

export function moveRow(rows: TaxonomyRow[], from: number, to: number): TaxonomyRow[] {
  if (from < 0 || to < 0 || from >= rows.length || to >= rows.length || from === to) return rows
  const next = [...rows]
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved)
  return next
}
