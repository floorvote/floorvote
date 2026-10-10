/**
 * Lenient CSV parsing for published data files. Quoted fields may hold commas,
 * doubled quotes and newlines; text after a closing quote is kept as part of
 * the field (Virginia's Sponsors.csv writes `"1" - Chief Patron`). Fields are
 * returned as written, untrimmed.
 *
 * Fields are cut from the text with slice, not built a character at a time:
 * appending character by character leaves V8 holding chains of tiny strings,
 * several times the file's size, which a Worker cannot afford for a 5 MB file.
 * Rows go to a callback, so a caller can fold a file without holding every row.
 */
export function forEachCsvRow(text: string, onRow: (row: string[]) => void): void {
  const n = text.length
  let i = 0
  while (i < n) {
    const row: string[] = []
    for (;;) {
      let field = ''
      let start = i
      if (text[i] === '"') {
        // Quoted: take pieces between quotes, a doubled quote standing for one.
        i++
        start = i
        for (;;) {
          const q = text.indexOf('"', i)
          if (q < 0) { field += text.slice(start); i = n; break }
          field += text.slice(start, q)
          if (text[q + 1] === '"') { field += '"'; i = q + 2; start = i; continue }
          i = q + 1
          break
        }
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
    if (text[i] === '\n') i++
    onRow(row)
  }
}

export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  forEachCsvRow(text, r => rows.push(r))
  return rows
}

/** Each row as an object keyed by the header row, with header names and values trimmed. Blank rows are skipped. */
export function forEachCsvRecord(text: string, onRecord: (rec: Record<string, string>) => void): void {
  let keys: string[] | null = null
  forEachCsvRow(text.replace(/^﻿/, ''), row => {
    if (!keys) { keys = row.map(h => h.trim().replace(/^"|"$/g, '')); return }
    if (!row.some(v => v.trim() !== '')) return
    const rec: Record<string, string> = {}
    keys.forEach((k, j) => { rec[k] = (row[j] ?? '').trim() })
    onRecord(rec)
  })
}

export function parseCsvRecords(text: string): Record<string, string>[] {
  const out: Record<string, string>[] = []
  forEachCsvRecord(text, r => out.push(r))
  return out
}
