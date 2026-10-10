import { rateLimitedFetch } from '../sdk'

/**
 * Client for the Virginia General Assembly's Legislative Information System
 * (LIS) public data files: CSVs per session, with no key.
 * https://lis.virginia.gov/data-files
 *
 * The LIS also has a REST API with bill text and meeting schedules, but it
 * needs a registered key and its terms restrict use, so this reads the files
 * only (see docs/internal/direct-sources.md).
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

function fileUrl(sessionCode: string, name: string): string {
  return `${LIS_FILES_BASE}/${sessionCode}/${name}`
}

/** One file's text, or '' when the session does not publish it. */
export async function getLisFile(sessionCode: string, file: LisFile, onRequest?: () => void): Promise<string> {
  const res = await rateLimitedFetch(fileUrl(sessionCode, LIS_FILES[file]), undefined, { ratePerSec: LIS_RATE_PER_SEC, bucketKey: 'lis', onRequest })
  if (res.status === 404) return ''
  if (!res.ok) throw new Error(`LIS HTTP ${res.status} for ${sessionCode}/${LIS_FILES[file]}`)
  return res.text()
}

/** Whether a session's bill list exists: a session appears with its first prefiled bills. */
export async function lisSessionExists(sessionCode: string, onRequest?: () => void): Promise<boolean> {
  const res = await rateLimitedFetch(fileUrl(sessionCode, LIS_FILES.bills), { method: 'HEAD' },
    { ratePerSec: LIS_RATE_PER_SEC, bucketKey: 'lis', onRequest })
  if (res.status === 404) return false
  if (!res.ok) throw new Error(`LIS HTTP ${res.status} for ${sessionCode}`)
  return true
}
