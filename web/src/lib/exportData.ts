import Papa from 'papaparse'
import JSZip from 'jszip'
import { apiFetch } from './api'
import { todayIso } from './calendarGrid'
import { EXPORT_TABLES, type ExportTable } from '../../../shared/exportTables'

// Rich data (amendments, supplements, roll-call votes) lives on central, not in
// the tenant DB, so it's pulled separately from the per-table dump and written
// to its own files (billAmendments / billSupplements / billRollCalls) in the zip.

type PaginatedResponse = {
  rows: Record<string, unknown>[]
  nextCursor: string | null
}

type RichResponse = {
  amendments: Record<string, unknown>[]
  supplements: Record<string, unknown>[]
  votes: Record<string, unknown>[]
  nextCursor: string | null
}

async function fetchAllRows(table: ExportTable): Promise<Record<string, unknown>[]> {
  const allRows: Record<string, unknown>[] = []
  let cursor: string | null = null

  do {
    const params = new URLSearchParams({ limit: '500' })
    if (cursor) params.set('cursor', cursor)

    const data = await apiFetch<PaginatedResponse>(`/admin/export/${table}?${params}`)
    allRows.push(...data.rows)
    cursor = data.nextCursor
  } while (cursor)

  return allRows
}

async function fetchAllRich(): Promise<{
  amendments: Record<string, unknown>[]
  supplements: Record<string, unknown>[]
  votes: Record<string, unknown>[]
}> {
  const amendments: Record<string, unknown>[] = []
  const supplements: Record<string, unknown>[] = []
  const votes: Record<string, unknown>[] = []
  let cursor: string | null = null

  do {
    const params = new URLSearchParams()
    if (cursor) params.set('cursor', cursor)

    const data = await apiFetch<RichResponse>(`/admin/export/rich?${params}`)
    amendments.push(...data.amendments)
    supplements.push(...data.supplements)
    votes.push(...data.votes)
    cursor = data.nextCursor
  } while (cursor)

  return { amendments, supplements, votes }
}

/**
 * Neutralizes CSV/spreadsheet formula injection.
 *
 * Excel, Google Sheets, and LibreOffice Calc treat a cell as a formula when
 * its value starts with `=`, `+`, `-`, `@`, tab (`\t`), carriage return (`\r`),
 * or line feed (`\n`). A member-supplied value (comment, note, custom field)
 * beginning with one of those characters can execute arbitrary formulas when an
 * admin opens the exported CSV. Prefixing the cell with a single apostrophe
 * (`'`) is the standard mitigation — spreadsheets interpret it as a text-prefix
 * marker and display the rest of the value literally. (Some apps — Sheets,
 * LibreOffice — show the leading apostrophe; Excel hides it. That cosmetic
 * tradeoff is accepted in exchange for neutralizing formula execution.)
 *
 * Only the leading character is examined; a `=` appearing mid-string is safe
 * and is left untouched.
 */
export function sanitizeCsvCell(value: unknown): unknown {
  if (typeof value !== 'string') return value
  if (value.length === 0) return value
  const first = value[0]
  if (
    first === '=' ||
    first === '+' ||
    first === '-' ||
    first === '@' ||
    first === '\t' ||
    first === '\r' ||
    first === '\n'
  ) {
    return "'" + value
  }
  return value
}

export function rowsToCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return ''

  // Stringify any JSON/object values before CSV conversion, then neutralize
  // formula-triggering leading characters (CSV injection mitigation).
  const prepared = rows.map(row => {
    const out: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(row)) {
      const stringified =
        typeof value === 'object' && value !== null ? JSON.stringify(value) : value
      out[key] = sanitizeCsvCell(stringified)
    }
    return out
  })

  return Papa.unparse(prepared)
}

export async function exportAllData(
  format: 'json' | 'csv',
  onProgress?: (tableName: string, tableIndex: number, totalTables: number) => void,
): Promise<void> {
  const zip = new JSZip()
  const dateStr = todayIso()
  const folder = zip.folder(`export-${dateStr}`)!

  const writeFile = (name: string, rows: Record<string, unknown>[]) => {
    if (format === 'csv') {
      folder.file(`${name}.csv`, rowsToCsv(rows))
    } else {
      folder.file(`${name}.json`, JSON.stringify(rows, null, 2))
    }
  }

  // One progress step per tenant table, plus one for the central rich-data pull.
  const totalSteps = EXPORT_TABLES.length + 1

  for (let i = 0; i < EXPORT_TABLES.length; i++) {
    const table = EXPORT_TABLES[i]
    onProgress?.(table, i, totalSteps)
    writeFile(table, await fetchAllRows(table))
  }

  // Amendments, supplements, and roll-call votes — fetched from central.
  onProgress?.('billAmendments', EXPORT_TABLES.length, totalSteps)
  const rich = await fetchAllRich()
  writeFile('billAmendments', rich.amendments)
  writeFile('billSupplements', rich.supplements)
  writeFile('billRollCalls', rich.votes)

  onProgress?.('done', totalSteps, totalSteps)

  const blob = await zip.generateAsync({ type: 'blob' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `export-${dateStr}.zip`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
