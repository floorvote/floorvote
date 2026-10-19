// Comment attachments (#465): the web side of api/src/routes/attachmentsApi.ts.
// An upload streams through the Worker: the file is the request body, so the
// browser sets Content-Length and the server can refuse before reading a byte.
import { color } from '../styles/tokens'

/** What the server sends for a file: in a comment's `attachments`, and as an upload's 201. */
export type AttachmentSummary = { id: string; name: string; contentType: string; size: number }

/** The limits `GET /config` reports, or null while attachments are off for the instance. */
export type AttachmentLimits = { maxBytes: number; maxPerComment: number }

export type AttachmentKind = { label: string; tile: string; bg: string; fg: string }

const PDF: AttachmentKind = { label: 'PDF', tile: 'PDF', bg: color.bgDangerSoft, fg: color.textDanger }
const WORD: AttachmentKind = { label: 'Word', tile: 'DOC', bg: color.bgBlueChip, fg: color.linkBlue }
const SHEET: AttachmentKind = { label: 'Spreadsheet', tile: 'XLS', bg: color.bgSuccessChip, fg: color.textSuccess }
const IMAGE: AttachmentKind = { label: 'Image', tile: 'IMG', bg: color.bgVioletChip, fg: color.textVioletChip }
const OTHER: AttachmentKind = { label: 'File', tile: 'FILE', bg: color.surfaceMuted, fg: color.textSecondary }

const BY_EXTENSION: Record<string, AttachmentKind> = {
  pdf: PDF,
  doc: WORD, docx: WORD, odt: WORD, rtf: WORD,
  xls: SHEET, xlsx: SHEET, ods: SHEET, csv: SHEET, tsv: SHEET,
  png: IMAGE, jpg: IMAGE, jpeg: IMAGE, gif: IMAGE, webp: IMAGE,
}

/** The tile for a file: by its stored content type, then by its extension when that type is generic. */
export function attachmentKind(contentType: string, name: string): AttachmentKind {
  const type = contentType.toLowerCase()
  if (type === 'application/pdf') return PDF
  if (type.startsWith('image/')) return IMAGE
  if (type.includes('wordprocessingml') || type === 'application/msword') return WORD
  if (type.includes('spreadsheetml') || type === 'application/vnd.ms-excel' || type === 'text/csv') return SHEET
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : ''
  return Object.prototype.hasOwnProperty.call(BY_EXTENSION, ext) ? BY_EXTENSION[ext] : OTHER
}

/** "900 B", "1.5 KB", "25 MB". */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let n = bytes / 1024
  let i = 0
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++ }
  return `${Number.isInteger(n) ? n : n.toFixed(1)} ${units[i]}`
}

/** Where a posted file downloads from. The server checks the session and the comment. */
export const attachmentUrl = (id: string) => `/api/attachments/${encodeURIComponent(id)}`

/**
 * Upload one file. Rejects with the server's own sentence when it refuses the
 * file (a blocked type, too large, over a limit), and with an AbortError when
 * `signal` fires.
 */
export async function uploadAttachment(file: File, signal?: AbortSignal): Promise<AttachmentSummary> {
  let res: Response
  try {
    res = await fetch(`/api/attachments?name=${encodeURIComponent(file.name)}`, {
      method: 'POST',
      body: file,
      credentials: 'include',
      signal,
    })
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e
    throw new Error('The upload failed. Check your connection and try again.')
  }
  if (!res.ok) {
    const body = await res.json().catch(() => null) as { error?: string } | null
    throw new Error(body?.error ?? 'The upload failed. Try again.')
  }
  return await res.json() as AttachmentSummary
}

/** Remove an upload that has not been posted. Best effort: the server also cleans up after a day. */
export async function removeAttachment(id: string): Promise<void> {
  await fetch(attachmentUrl(id), { method: 'DELETE', credentials: 'include' })
}
