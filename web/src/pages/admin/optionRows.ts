// The dropdown options editor keeps one row per option, and each row remembers the text its option had when the
// editor opened (`original`, null for a row added since). A rename is a row whose text changed, so the API is told
// exactly which options were renamed (and views that filter on them follow), instead of guessing from two lists.

export type OptionRow = { original: string | null; text: string }

export type OptionRename = { from: string; to: string }

export function rowsFromOptions(options: readonly string[] | null | undefined): OptionRow[] {
  return (options ?? []).map(o => ({ original: o, text: o }))
}

/** The options to save (trimmed, empty rows dropped) and the renames among them: rows that had an option and now read differently. */
export function optionsFromRows(rows: readonly OptionRow[]): { options: string[]; renames: OptionRename[] } {
  const options: string[] = []
  const renames: OptionRename[] = []
  for (const row of rows) {
    const text = row.text.trim()
    if (!text) continue
    options.push(text)
    if (row.original !== null && text !== row.original) renames.push({ from: row.original, to: text })
  }
  return { options, renames }
}
