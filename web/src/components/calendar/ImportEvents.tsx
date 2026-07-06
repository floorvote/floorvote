import { useEffect, useRef, useState, type CSSProperties } from 'react'
import Papa from 'papaparse'
import { apiFetch } from '../../lib/api'
import { color, radius, fontSize, fontWeight, shadow } from '../../styles/tokens'
import { matchHeaders, rowToImport, type ImportRowPreview, type RawRow } from '../../lib/calendarImportParse'

interface Props {
  onClose: () => void
  onImported: () => void
}

interface ImportResult {
  created: number
  updated: number
  unchanged: number
  skipped: number
}

function StatusBadge({ status }: { status: ImportRowPreview['status'] }) {
  const styles: Record<ImportRowPreview['status'], React.CSSProperties> = {
    ok: { background: color.bgSuccessChip, color: color.textSuccessDark, borderRadius: radius.sm, padding: '1px 6px', fontSize: fontSize.xs, fontWeight: fontWeight.medium },
    warning: { background: color.bgAmberPriority, color: color.textAmberDark, borderRadius: radius.sm, padding: '1px 6px', fontSize: fontSize.xs, fontWeight: fontWeight.medium },
    skip: { background: color.surfaceMuted, color: color.textMuted, borderRadius: radius.sm, padding: '1px 6px', fontSize: fontSize.xs, fontWeight: fontWeight.medium },
  }
  const labels = { ok: '✓ ok', warning: '⚠ warning', skip: '— skip' }
  return <span style={styles[status]}>{labels[status]}</span>
}

// Re-derive a row's status from its (possibly edited) fields. A row is importable
// once it has a title and a valid date; otherwise it's flagged so the admin can fix
// it inline before creating.
function recompute(r: ImportRowPreview): ImportRowPreview {
  const title = r.title.trim()
  if (!title) return { ...r, status: 'skip', reason: 'add a title to include' }
  if (!r.dateIso) return { ...r, status: 'warning', reason: r.rawDate ? `unrecognized date “${r.rawDate}” — pick one` : 'pick a date' }
  return { ...r, status: 'ok', reason: undefined }
}

const fieldStyle: CSSProperties = {
  width: '100%', boxSizing: 'border-box', padding: '6px 8px', fontSize: fontSize.sm,
  borderRadius: radius.md, border: `1px solid ${color.borderDefault}`, color: color.textPrimary,
  fontFamily: 'inherit',
}

export function ImportEvents({ onClose, onImported }: Props) {
  const [rows, setRows] = useState<ImportRowPreview[]>([])
  const [fileName, setFileName] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [result, setResult] = useState<ImportResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  async function handleFile(file: File) {
    setFileName(file.name)
    setRows([])
    setResult(null)
    setError(null)
    try {
      const csv = Papa.parse<string[]>(await file.text(), { skipEmptyLines: 'greedy' })
      const matrix = csv.data
      if (matrix.length === 0) {
        setError(
          csv.errors[0]?.message
            ? `Could not read this file as CSV: ${csv.errors[0].message}`
            : 'No rows found in this file.',
        )
        return
      }

      // Find header row: first row (up to row 10) where matchHeaders finds title+beginDate
      let headerRowIdx = -1
      let headerMap = null
      for (let i = 0; i < Math.min(10, matrix.length); i++) {
        const rowAsStrings = (matrix[i] as unknown[]).map(c => String(c ?? ''))
        const candidate = matchHeaders(rowAsStrings)
        if (candidate.title !== null && candidate.beginDate !== null) {
          headerRowIdx = i
          headerMap = candidate
          break
        }
      }

      if (!headerMap || headerRowIdx < 0) {
        setError('Could not find a header row with "Title" and a date column. Check the template format.')
        return
      }

      const headers = (matrix[headerRowIdx] as unknown[]).map(c => String(c ?? ''))
      const dataRows: RawRow[] = []
      for (let i = headerRowIdx + 1; i < matrix.length; i++) {
        const cells = matrix[i] as unknown[]
        const row: RawRow = {}
        headers.forEach((h, idx) => { row[h] = cells[idx] ?? '' })
        dataRows.push(row)
      }

      const parsed = dataRows.map(r => rowToImport(r, headerMap!))
      setRows(parsed)
    } catch (err) {
      setError(`Failed to read file: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (file) handleFile(file)
  }

  // Edit any field of a previewed row inline; status re-derives from the edit.
  function updateRow(idx: number, patch: Partial<ImportRowPreview>) {
    setRows(prev => prev.map((r, i) => (i === idx ? recompute({ ...r, ...patch }) : r)))
  }

  function downloadTemplate() {
    // Only Title + Date are required; the second row shows a minimal event, the
    // first a fully-specified one. Quote any value that contains a comma.
    const csv =
      "Title,Date,Time,Location,Description,Link\n" +
      "Voter registration deadline,2026-05-04,17:00,County Clerk's Office,\"Last day to register for the June primary. Photo ID required.\",https://sos.example.gov/register\n" +
      "Primary election day,2026-06-02,,,,\n" +
      "Candidate filing window opens,2026-03-02,09:00,,\"Forms available on the Secretary of State website.\",https://sos.example.gov/candidates\n"
    const blob = new Blob(['﻿', csv], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'calendar-import-template.csv'
    a.click()
    URL.revokeObjectURL(url)
  }

  async function handleConfirm() {
    const okRows = rows.filter(r => r.status === 'ok')
    if (!okRows.length) return
    setSubmitting(true)
    setError(null)
    try {
      const res = await apiFetch<ImportResult>('/calendar/import', {
        method: 'POST',
        body: JSON.stringify({
          rows: okRows.map(r => ({
            title: r.title,
            date: r.dateIso,
            details: r.details,
            time: r.time,
            location: r.location,
            url: r.url,
          })),
        }),
      })
      setResult(res)
      onImported()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Import failed')
    } finally {
      setSubmitting(false)
    }
  }

  const okCount = rows.filter(r => r.status === 'ok').length
  const warnCount = rows.filter(r => r.status === 'warning').length
  const skipCount = rows.filter(r => r.status === 'skip').length

  return (
    <div
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.3)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
      }}
    >
      <div style={{
        background: color.white, borderRadius: radius.lg, padding: 24,
        width: 640, maxWidth: 'calc(100vw - 32px)', maxHeight: 'calc(100vh - 64px)',
        overflowY: 'auto', boxShadow: shadow.lg, position: 'relative',
      }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
          <div style={{ fontWeight: fontWeight.bold, fontSize: fontSize.lg, color: color.textPrimary }}>
            Import events
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: color.textMuted, fontSize: fontSize.xl, lineHeight: 1, padding: '0 4px' }}
          >×</button>
        </div>

        {/* Instructions + template download */}
        <div style={{ fontSize: fontSize.sm, color: color.textSecondary, marginBottom: 12, lineHeight: 1.5 }}>
          Upload a CSV file. <strong>Title</strong> and <strong>Date</strong> are required; <strong>Time</strong>, <strong>Location</strong>, <strong>Description</strong>, and <strong>Link</strong> are optional. Any extra columns are appended to the event description.
        </div>
        <button
          type="button"
          onClick={downloadTemplate}
          style={{
            background: 'none', border: `1px solid ${color.borderDefault}`, borderRadius: radius.md,
            padding: '5px 12px', fontSize: fontSize.sm, color: color.textSlate, cursor: 'pointer', marginBottom: 16,
          }}
        >
          Download template
        </button>

        {/* File input */}
        <div style={{ marginBottom: 16 }}>
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,text/csv"
            onChange={handleFileChange}
            style={{ fontSize: fontSize.sm, color: color.textPrimary }}
          />
        </div>

        {/* Error */}
        {error && (
          <div style={{
            background: color.bgDangerSoft, border: `1px solid ${color.borderRedChip}`, borderRadius: radius.md,
            padding: '10px 14px', fontSize: fontSize.sm, color: color.textDanger, marginBottom: 16,
          }}>
            {error}
          </div>
        )}

        {/* Result summary */}
        {result && (
          <>
            <div style={{
              background: color.bgSuccess, border: `1px solid ${color.borderGreenChip}`, borderRadius: radius.md,
              padding: '10px 14px', fontSize: fontSize.sm, color: color.textSuccessDark, marginBottom: 16,
            }}>
              Created {result.created} · {result.updated} updated · {result.unchanged} unchanged · {result.skipped} skipped
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button
                type="button"
                onClick={onClose}
                style={{
                  background: color.accentBlue, color: color.white, border: 'none', borderRadius: radius.md,
                  padding: '8px 16px', fontSize: fontSize.sm, fontWeight: fontWeight.medium, cursor: 'pointer',
                }}
              >
                Done
              </button>
            </div>
          </>
        )}

        {/* Preview */}
        {rows.length > 0 && !result && (
          <>
            {/* Summary banner */}
            <div style={{
              display: 'flex', gap: 12, flexWrap: 'wrap', fontSize: fontSize.sm,
              padding: '8px 12px', background: color.surfaceMuted, borderRadius: radius.md,
              marginBottom: 12, color: color.textSecondary,
            }}>
              <span><strong style={{ color: color.textSuccessDark }}>{okCount}</strong> ok</span>
              {warnCount > 0 && <span><strong style={{ color: color.textAmberDark }}>{warnCount}</strong> warning</span>}
              {skipCount > 0 && <span><strong style={{ color: color.textMuted }}>{skipCount}</strong> skip</span>}
              <span style={{ color: color.textMuted }}>({rows.length} total row{rows.length === 1 ? '' : 's'})</span>
            </div>

            {/* Editable preview — review and fix any field before creating */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
              {rows.map((row, idx) => (
                <div
                  key={idx}
                  style={{
                    border: `1px solid ${row.status === 'warning' ? color.borderAmber : color.borderDefault}`,
                    borderRadius: radius.md, padding: 10,
                    opacity: row.status === 'skip' ? 0.6 : 1,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                    <StatusBadge status={row.status} />
                    {row.reason && (
                      <span style={{ fontSize: fontSize.xs, color: row.status === 'warning' ? color.textAmberDark : color.textMuted }}>
                        {row.reason}
                      </span>
                    )}
                  </div>
                  <input
                    aria-label="Title"
                    placeholder="Title (required)"
                    value={row.title}
                    onChange={e => updateRow(idx, { title: e.target.value })}
                    style={{ ...fieldStyle, fontWeight: fontWeight.semibold, marginBottom: 6 }}
                  />
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
                    <input
                      aria-label="Date" type="date" max="9999-12-31"
                      value={row.dateIso ?? ''}
                      onChange={e => updateRow(idx, { dateIso: e.target.value || null, rawDate: undefined })}
                      style={{ ...fieldStyle, width: 150 }}
                    />
                    <input
                      aria-label="Time" type="time"
                      value={row.time ?? ''}
                      onChange={e => updateRow(idx, { time: e.target.value || null })}
                      style={{ ...fieldStyle, width: 120 }}
                    />
                    <input
                      aria-label="Location" placeholder="Location"
                      value={row.location ?? ''}
                      onChange={e => updateRow(idx, { location: e.target.value || null })}
                      style={{ ...fieldStyle, flex: 1, minWidth: 120, width: 'auto' }}
                    />
                  </div>
                  <input
                    aria-label="Link" placeholder="Link (https://…)"
                    value={row.url ?? ''}
                    onChange={e => updateRow(idx, { url: e.target.value || null })}
                    style={{ ...fieldStyle, marginBottom: 6 }}
                  />
                  <textarea
                    aria-label="Description" placeholder="Description" rows={2}
                    value={row.details ?? ''}
                    onChange={e => updateRow(idx, { details: e.target.value || null })}
                    style={{ ...fieldStyle, resize: 'vertical' }}
                  />
                </div>
              ))}
            </div>

            {/* Confirm button */}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
              <button
                type="button"
                onClick={onClose}
                style={{
                  background: 'none', border: `1px solid ${color.borderDefault}`, borderRadius: radius.md,
                  padding: '8px 16px', fontSize: fontSize.sm, color: color.textSlate, cursor: 'pointer',
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirm}
                disabled={okCount === 0 || submitting}
                style={{
                  background: okCount === 0 ? color.bgRedDisabled : color.accentBlue,
                  color: color.white, border: 'none', borderRadius: radius.md,
                  padding: '8px 16px', fontSize: fontSize.sm, fontWeight: fontWeight.medium,
                  cursor: okCount === 0 || submitting ? 'not-allowed' : 'pointer',
                  opacity: submitting ? 0.7 : 1,
                }}
              >
                {submitting ? 'Importing…' : `Create ${okCount} event${okCount === 1 ? '' : 's'}`}
              </button>
            </div>
          </>
        )}

        {/* Empty state when file is chosen but no rows parsed */}
        {fileName && rows.length === 0 && !error && !result && (
          <div style={{ color: color.textMuted, fontSize: fontSize.sm }}>
            Processing…
          </div>
        )}
      </div>
    </div>
  )
}
