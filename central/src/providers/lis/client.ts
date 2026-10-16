import { rateLimitedFetch } from '../sdk'

/**
 * Client for the Virginia General Assembly's Legislative Information System
 * (LIS): its public data files (CSVs per session, with no key), and, for bill
 * text, its REST API (`getLisTextList`, `getLisTextPdf`), which needs a key.
 * https://lis.virginia.gov/data-files
 *
 * The API is optional. Its terms allow non-commercial use only, so a
 * deployment turns it on by setting `LIS_API_KEY` (and takes on the terms).
 * Without a key the provider reads the files alone, and Virginia bills have no
 * text. The API's bill text is served as PDFs from the same public blob store
 * as the files, which core downloads with no key.
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

/** The LIS API's bill text service. Every call sends the key in a `WebAPIKey` header. */
export const LIS_API_BASE = 'https://lis.virginia.gov/LegislationText/api'

/** One version of a bill's text, as the session's text list gives it. The rows carry no file links. */
export interface LisTextRow {
  LegislationNumber: string
  LegislationTextID: number
  /** 1 through 7 are full bill text (map.ts, `lisIsFullText`). 8 through 11 are amendments and the like. */
  LegislationVersionID: number
  /** Not always trimmed, and null on some rows. */
  DocumentCode?: string | null
  /** "Introduced", "Enrolled", and so on. */
  Version?: string | null
  Description?: string | null
  /** "2025-11-17T00:00:00". */
  DraftDate?: string | null
}

async function apiGet(operation: string, query: string, apiKey: string, onRequest?: () => void): Promise<unknown> {
  const res = await rateLimitedFetch(`${LIS_API_BASE}/${operation}?${query}`, { headers: { WebAPIKey: apiKey } },
    { ratePerSec: LIS_RATE_PER_SEC, bucketKey: 'lis', onRequest })
  if (!res.ok) throw new Error(`LIS HTTP ${res.status} for ${operation}`)
  try {
    return await res.json()
  } catch {
    throw new Error(`LIS ${operation}: the answer isn't JSON`)
  }
}

function asObject(body: unknown, operation: string): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new Error(`LIS ${operation}: the answer isn't an object`)
  return body as Record<string, unknown>
}

/**
 * Every version of every bill's text in one session, in one call: with no bill
 * filter the API lists the whole session (12,000 rows for a regular session).
 *
 * Fails closed: an HTTP error, a body that isn't JSON, an answer with no
 * `LegislationTextList` array, an API-reported failure, or a row missing the
 * fields the mapping reads throws, so the pass stores nothing from it. An empty
 * list is returned as empty.
 */
export async function getLisTextList(sessionCode: string, apiKey: string, onRequest?: () => void): Promise<LisTextRow[]> {
  const operation = 'getlegislationtextlistasync'
  const body = asObject(await apiGet(operation, `sessionCode=${encodeURIComponent(sessionCode)}`, apiKey, onRequest), operation)
  if (body.Success === false) throw new Error(`LIS ${operation}: ${String(body.FailureMessage || 'the API reported a failure')}`)
  const list = body.LegislationTextList
  if (!Array.isArray(list)) throw new Error(`LIS ${operation}: the answer has no LegislationTextList`)
  for (const row of list) {
    const r = row as Partial<Record<keyof LisTextRow, unknown>> | null
    if (typeof r !== 'object' || r === null || typeof r.LegislationNumber !== 'string'
      || typeof r.LegislationTextID !== 'number' || typeof r.LegislationVersionID !== 'number') {
      throw new Error(`LIS ${operation}: a row lacks its LegislationNumber, LegislationTextID, or LegislationVersionID`)
    }
  }
  return list as LisTextRow[]
}

/**
 * The PDF link of one text version, from its by-id answer, or null when the
 * version has no PDF. The answer lists the text in `TextsList`, an entry with
 * its file lists (`PDFFile[].FileURL` is a public link in the blob store) and
 * the text as HTML, which isn't used. The entry read is the one whose
 * `LegislationTextID` is the id asked for, never just the first.
 *
 * Fails closed on an HTTP error, a body that isn't JSON, `Success: false`, an
 * answer with no `TextsList` array, a list with no entry for the id, an entry
 * with no `PDFFile` array, and a `PDFFile` entry with no `FileURL`.
 */
export async function getLisTextPdf(textId: number, apiKey: string, onRequest?: () => void): Promise<string | null> {
  const operation = 'getlegislationtextbyidasync'
  const answer = asObject(await apiGet(operation, `legislationTextID=${encodeURIComponent(String(textId))}`, apiKey, onRequest), operation)
  if (answer.Success === false) throw new Error(`LIS ${operation}: ${String(answer.FailureMessage || 'the API reported a failure')}`)
  const list = answer.TextsList
  if (!Array.isArray(list)) throw new Error(`LIS ${operation}: the answer has no TextsList`)
  const entry = list.find(t => typeof t === 'object' && t !== null && (t as { LegislationTextID?: unknown }).LegislationTextID === textId)
  if (!entry) throw new Error(`LIS ${operation}: TextsList has no entry for text ${textId}`)
  const files = (entry as { PDFFile?: unknown }).PDFFile
  if (!Array.isArray(files)) throw new Error(`LIS ${operation}: text ${textId} has no PDFFile`)
  const urls = files.map(f => (typeof f === 'object' && f !== null ? (f as { FileURL?: unknown }).FileURL : undefined))
  if (!urls.every(u => typeof u === 'string' && u !== '')) throw new Error(`LIS ${operation}: a PDFFile entry of text ${textId} has no FileURL`)
  return (urls[0] as string | undefined) ?? null
}
