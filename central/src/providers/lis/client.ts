import { rateLimitedFetch } from '../sdk'

/**
 * Client for the Virginia General Assembly's Legislative Information System
 * (LIS) public data files: CSVs per session, with no key.
 * https://lis.virginia.gov/data-files
 *
 * The LIS also has a REST API with bill text and meeting schedules, but its
 * terms restrict use to non-commercial purposes, so this reads the files only
 * and Virginia bills have no text.
 */
export const LIS_FILES_BASE = 'https://lis.blob.core.windows.net/lisfiles'

const LIS_RATE_PER_SEC = 2

/** The files a pass reads, by the case-sensitive names the LIS publishes. */
export const LIS_FILES = {
  bills: 'BILLS.CSV',
  history: 'HISTORY.CSV',
  votes: 'VOTE.CSV',
  sponsors: 'Sponsors.csv',
  summaries: 'Summaries.csv',
  fiscal: 'FiscalImpactStatements.csv',
  dockets: 'DOCKET.CSV',
  subdockets: 'SUBDOCKET.CSV',
  members: 'Members.csv',
  committees: 'Committees.csv',
} as const

export type LisFile = keyof typeof LIS_FILES
export type LisFiles = Record<LisFile, string>

/** One file as read: its text and ETag. */
export interface LisFileRead { text: string; etag: string | null }

function fileUrl(sessionCode: string, name: string): string {
  return `${LIS_FILES_BASE}/${sessionCode}/${name}`
}

function fetchFile(sessionCode: string, file: LisFile, method: 'GET' | 'HEAD', onRequest?: () => void): Promise<Response> {
  return rateLimitedFetch(fileUrl(sessionCode, LIS_FILES[file]), { method },
    { ratePerSec: LIS_RATE_PER_SEC, bucketKey: 'lis', onRequest })
}

/**
 * One file's text and ETag, or null when the session doesn't publish it (a
 * 404). Whether a missing file is acceptable is the caller's decision: most
 * aren't (map.ts, `checkLisFiles`).
 *
 * Fails closed on what a cut-off download looks like: an HTTP error, a body
 * shorter or longer than its Content-Length, or a file that doesn't end with
 * a line break (every LIS file does). The CSV parse catches the rest: a quote
 * that never closes, or a row missing fields.
 */
export async function getLisFile(sessionCode: string, file: LisFile, onRequest?: () => void): Promise<LisFileRead | null> {
  const where = `${sessionCode}/${LIS_FILES[file]}`
  const res = await fetchFile(sessionCode, file, 'GET', onRequest)
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`LIS HTTP ${res.status} for ${where}`)
  const bytes = await res.arrayBuffer()
  const declared = res.headers.get('Content-Length')
  // A compressed body's length is the compressed size, so only an identity body is checked.
  if (declared !== null && !res.headers.get('Content-Encoding') && Number(declared) !== bytes.byteLength) {
    throw new Error(`LIS ${where}: got ${bytes.byteLength} bytes of ${declared}, so the file is truncated`)
  }
  const text = new TextDecoder().decode(bytes)
  if (text !== '' && !text.endsWith('\n')) throw new Error(`LIS ${where}: the file doesn't end with a line break, so it is truncated`)
  return { text, etag: res.headers.get('ETag') }
}

/** A file's current ETag, without its body: null when the session doesn't publish it. */
export async function getLisFileEtag(sessionCode: string, file: LisFile, onRequest?: () => void): Promise<string | null> {
  const res = await fetchFile(sessionCode, file, 'HEAD', onRequest)
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`LIS HTTP ${res.status} for ${sessionCode}/${LIS_FILES[file]}`)
  // A file with no ETag reads as changed every time, which is safe.
  return res.headers.get('ETag') ?? ''
}

/** Whether a session's bill list exists: a session appears with its first prefiled bills. */
export async function lisSessionExists(sessionCode: string, onRequest?: () => void): Promise<boolean> {
  return (await getLisFileEtag(sessionCode, 'bills', onRequest)) !== null
}
