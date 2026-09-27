/**
 * Id ranges for records sourced from the DC Council LIMS API.
 *
 * LIMS rows live in the same central tables as LegiScan rows, so tenants keep
 * addressing every bill as `legiscan:<int>` and nothing downstream changes. To
 * keep the two sources from colliding, LIMS ids are offset into a range LegiScan
 * never reaches (its bill, doc and session ids are in the low millions at most).
 *
 * The range doubles as the provider discriminator: code that is about to call
 * LegiScan for a bill, document or session checks these predicates first, so a
 * LIMS id is never sent to api.legiscan.com (which would fail, and cost quota).
 *
 *   bill_id     = LIMS_BILL_ID_BASE    + legislationId
 *   session_id  = LIMS_SESSION_ID_BASE + councilPeriodId
 *   doc_id etc. = LIMS_DOC_ID_BASE     + the document's LIMS download Id
 */
export const LIMS_BILL_ID_BASE = 1_000_000_000
export const LIMS_SESSION_ID_BASE = 1_000_000_000
export const LIMS_DOC_ID_BASE = 2_000_000_000
const RANGE = 1_000_000_000

export function isLimsBillId(billId: number): boolean {
  return billId >= LIMS_BILL_ID_BASE && billId < LIMS_BILL_ID_BASE + RANGE
}

export function isLimsSessionId(sessionId: number): boolean {
  return sessionId >= LIMS_SESSION_ID_BASE && sessionId < LIMS_SESSION_ID_BASE + RANGE
}

export function isLimsDocId(docId: number): boolean {
  return docId >= LIMS_DOC_ID_BASE && docId < LIMS_DOC_ID_BASE + RANGE
}

export function limsBillId(legislationId: number): number {
  return LIMS_BILL_ID_BASE + legislationId
}

export function limsSessionId(councilPeriodId: number): number {
  return LIMS_SESSION_ID_BASE + councilPeriodId
}

export function limsDocId(downloadId: number): number {
  return LIMS_DOC_ID_BASE + downloadId
}
