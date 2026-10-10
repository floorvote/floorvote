/**
 * CSV parsing for published data files. Quoted fields may hold commas,
 * doubled quotes and newlines; text after a closing quote is kept as part of
 * the field (Virginia's Sponsors.csv writes `"1" - Chief Patron`). Fields are
 * returned as written, untrimmed.
 *
 * Strict where a cut-off file would show: a quote that never closes, or (for
 * a file with a header) a row with more or fewer fields than the header,
 * throws a CsvError. A file that ends mid-row fails one of the two.
 *
 * Fields are cut from the text with slice, not built a character at a time:
 * appending character by character leaves V8 holding chains of tiny strings,
 * several times the file's size, which a Worker cannot afford for a 5 MB file.
 * Rows go to a callback, so a caller can fold a file without holding every row.
 */

export class CsvError extends Error {}

export function forEachCsvRow(text: string, onRow: (row: string[], line: number) => void): void {
  const n = text.length
  let i = 0
  let line = 1
  while (i < n) {
    const row: string[] = []
    const rowLine = line
    for (;;) {
      let field = ''
      let start = i
      if (text[i] === '"') {
        // Quoted: take pieces between quotes, a doubled quote standing for one.
        i++
        start = i
        for (;;) {
          const q = text.indexOf('"', i)
          if (q < 0) throw new CsvError(`a quote opened on line ${rowLine} never closes`)
          field += text.slice(start, q)
          if (text[q + 1] === '"') { field += '"'; i = q + 2; start = i; continue }
          i = q + 1
          break
        }
        for (let nl = field.indexOf('\n'); nl >= 0; nl = field.indexOf('\n', nl + 1)) line++
        start = i
      }
      // Unquoted text, or anything after a closing quote, up to the field's end.
      while (i < n && text[i] !== ',' && text[i] !== '\n' && text[i] !== '\r') i++
      if (i > start) field += text.slice(start, i)
      row.push(field)
      if (i < n && text[i] === ',') { i++; continue }
      break
    }
    if (text[i] === '\r') i++
    if (text[i] === '\n') { i++; line++ }
    onRow(row, rowLine)
  }
}

export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  forEachCsvRow(text, r => rows.push(r))
  return rows
}

/**
 * Each row as an object keyed by the header row, with header names and values
 * trimmed. Blank lines are skipped. Throws a CsvError for a header without
 * every column in `required`, and for a row whose field count differs from
 * the header's.
 */
export function forEachCsvRecord(
  text: string, onRecord: (rec: Record<string, string>) => void, required: readonly string[] = [],
): void {
  let keys: string[] | null = null
  forEachCsvRow(text.replace(/^﻿/, ''), (row, line) => {
    if (!keys) {
      keys = row.map(h => h.trim().replace(/^"|"$/g, ''))
      const missing = required.filter(k => !keys!.includes(k))
      if (missing.length > 0) throw new CsvError(`the header has no ${missing.join(', ')}`)
      return
    }
    if (row.length === 1 && row[0].trim() === '') return
    if (row.length !== keys.length) throw new CsvError(`line ${line} has ${row.length} fields, not the header's ${keys.length}`)
    const rec: Record<string, string> = {}
    keys.forEach((k, j) => { rec[k] = row[j].trim() })
    onRecord(rec)
  })
  if (!keys) throw new CsvError('it has no header')
}

export function parseCsvRecords(text: string, required: readonly string[] = []): Record<string, string>[] {
  const out: Record<string, string>[] = []
  forEachCsvRecord(text, r => out.push(r), required)
  return out
}
