/**
 * Id ranges for records sourced from the DC Council LIMS API.
 *
 * LIMS rows live in the same central tables as LegiScan rows, so tenants keep
 * addressing every bill as `legiscan:<int>` and nothing downstream changes. To
 * keep the two sources from colliding, LIMS ids are offset into a range LegiScan
 * never reaches (its bill, doc and session ids are in the low millions at most).
 *
 * Which source a row came from is recorded in its `source` column (see
 * src/providers); the ranges only keep LIMS ids from colliding with LegiScan's.
 *
 *   bill_id      = LIMS_BILL_ID_BASE + typeCode*1e7 + councilPeriod*1e5 + seq
 *                  (computed from the measure number, e.g. B26-0400 -> 1_012_600_400,
 *                  because BulkData rows carry the number but no internal id)
 *   session_id   = LIMS_SESSION_ID_BASE + councilPeriodId
 *   people_id    = LIMS_PEOPLE_ID_BASE  + LIMS member id
 *   doc_id, supplement_id, amendment_id
 *                = LIMS_DOC_ID_BASE     + the `?Id=` in the document's download URL
 *                  (one global sequence across document types)
 *   roll_call_id = LIMS_ROLL_CALL_ID_BASE + (bill_id - LIMS_BILL_ID_BASE)*100 + vote index
 */
export const LIMS_BILL_ID_BASE = 1_000_000_000
export const LIMS_SESSION_ID_BASE = 1_000_000_000
export const LIMS_DOC_ID_BASE = 2_000_000_000
export const LIMS_PEOPLE_ID_BASE = 1_000_000_000
export const LIMS_ROLL_CALL_ID_BASE = 1_000_000_000_000
const RANGE = 1_000_000_000

/**
 * Measure-number prefixes, in a fixed order: the index is part of the bill id,
 * so entries may be appended but never reordered or removed.
 */
const PREFIXES = [
  'B', 'PR', 'CER', 'CA', 'GBM', 'REPROG', 'HFA', 'HN', 'HR',
  'RC', 'ANC', 'AU', 'CFO', 'IG', 'AG',
] as const

const NUMBER_RE = /^([A-Z]+)(\d{1,2})-(\d{1,5})$/

export function isLimsBillId(billId: number): boolean {
  return billId >= LIMS_BILL_ID_BASE && billId < LIMS_BILL_ID_BASE + RANGE
}

export function isLimsSessionId(sessionId: number): boolean {
  return sessionId >= LIMS_SESSION_ID_BASE && sessionId < LIMS_SESSION_ID_BASE + RANGE
}

export function isLimsDocId(docId: number): boolean {
  return docId >= LIMS_DOC_ID_BASE && docId < LIMS_DOC_ID_BASE + RANGE
}

/**
 * Bill id for a LIMS measure number such as "B26-0400" or "REPROG26-0153".
 * Returns null for a number whose shape or prefix this code does not know, so
 * callers can skip it instead of minting an id that might later collide.
 */
export function limsBillId(legislationNumber: string): number | null {
  const m = NUMBER_RE.exec(legislationNumber.trim())
  if (!m) return null
  const code = PREFIXES.indexOf(m[1] as typeof PREFIXES[number]) + 1
  if (code === 0) return null
  return LIMS_BILL_ID_BASE + code * 10_000_000 + Number(m[2]) * 100_000 + Number(m[3])
}

/** Inverse of limsBillId: 1_012_600_400 -> "B26-0400". */
export function limsNumberFromBillId(billId: number): string | null {
  if (!isLimsBillId(billId)) return null
  const n = billId - LIMS_BILL_ID_BASE
  const prefix = PREFIXES[Math.floor(n / 10_000_000) - 1]
  if (!prefix) return null
  const period = Math.floor(n / 100_000) % 100
  const seq = n % 100_000
  return `${prefix}${period}-${String(seq).padStart(4, '0')}`
}

export function limsPeopleId(memberId: number): number {
  return LIMS_PEOPLE_ID_BASE + memberId
}

export function limsRollCallId(billId: number, voteIndex: number): number {
  return LIMS_ROLL_CALL_ID_BASE + (billId - LIMS_BILL_ID_BASE) * 100 + voteIndex
}

export function limsSessionId(councilPeriodId: number): number {
  return LIMS_SESSION_ID_BASE + councilPeriodId
}

export function limsDocId(downloadId: number): number {
  return LIMS_DOC_ID_BASE + downloadId
}
