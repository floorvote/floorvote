import { rateLimitedFetch } from '../sdk'

/**
 * Client for the DC Council Legislative Information Management System (LIMS)
 * public API, v2. https://lims.dccouncil.gov/api/help/index.html
 *
 * Auth is a developer key sent as a Bearer token. The response shapes below are
 * taken from live responses: the published OpenAPI document declares request
 * shapes and some view models, but not the BulkData or SearchLegislation
 * responses. inventory.ts says what the mapping does with each field.
 *
 * Every call fails closed. An HTTP error, a body that isn't JSON, or a body
 * whose shape isn't what the mapping reads throws, so the sync or the ingest
 * stops (and the ingest retries) without writing anything from it. An empty
 * list is returned as empty, and callers read it as "nothing new", never as
 * "everything was removed".
 */
const BASE_URL = 'https://lims.dccouncil.gov/api/v2/PublicData/'

/**
 * LIMS publishes no rate limit. Pace conservatively: the sync makes a handful of
 * bulk calls a day plus one details call per changed bill, so throughput is
 * never the constraint.
 */
const LIMS_RATE_PER_SEC = 1

export interface LimsCouncilPeriod {
  councilPeriodId: number
  councilPeriod: string  // e.g. "26 (2025-26)"
  startDate: string      // "2025-01-02T00:00:00"
  endDate: string
}

/** One history row inside a BulkData record. Dates are "Jan 06, 2025". */
export interface LimsBulkHistoryEntry {
  legislationNumber: string
  actionDate: string
  actionDescription: string | null
  downloadURL: string
}

/** One record from POST BulkData/{categoryId}/{councilPeriodId}. */
export interface LimsBulkRecord {
  legislationNumber: string        // "B26-0400"
  legislationCategory: string      // "Bill"
  legislationSubCategory: string | null  // "Permanent Bill"
  title: string
  introductionDate: string         // "Oct 06, 2025"
  introducedBy: string             // "Councilmember Z. Parker " (free text)
  coSponsors: string               // free text, often ""
  committeeReferral: string
  actResNumber: string | null
  lawNumber: string | null
  projectedLawDate: string | null
  status: string                   // "Under Council Review", "Official Law", ...
  legislationHistory: LimsBulkHistoryEntry[]
}

export interface LimsMember {
  memberName: string  // "Parker, Zachary"
  memberTitle: string
}

export interface LimsCommitteeHearing {
  hearingDate: string | null
  hearingType: string | null
  videoLink: string | null
  hearingNotice: string | null
  cancellationHearingNotice: string | null
  noticeFiledDate: string | null
  noticePublicationDate: string | null
  hearingRecord: string | null
}

export interface LimsCommitteeMarkup {
  committeeActionDate: string | null
  committeePrint: string | null
  committeeReport: string | null
  reportFiledDate: string | null
  videoLink: string | null
}

export interface LimsVoteDetails {
  voteType: string
  voteResult: string
  votes: { councilMember: string; vote: string }[]
}

export interface LimsAction {
  action: string
  actionDate: string | null
  videoLink: string | null
  attachmentType: string | null
  attachment: string | null
  voteDetails: LimsVoteDetails | null
}

export interface LimsDocument {
  legislationDocumentId: number
  documentTypeId: number
  documentTypeName: string
  documentTitle: string | null
  url: string
}

/** `mayoralReview` in LegislationDetails, once the Council has passed an act. */
export interface LimsMayoralReview {
  transmittedDate: string | null
  responseDueDate: string | null
  returnedDate: string | null
  signedDate: string | null
  signedAct: string | null
  actNumber: string | null
  enactedDate: string | null
  vetoDate: string | null
  expirationDate: string | null
  actPublicationDate: string | null
  actPublicationPageNumber: string | null
  actPublicationVolume: string | null
}

/** `congressionalReview` in LegislationDetails, once an act goes to Congress. */
export interface LimsCongressionalReview {
  transmittedDate: string | null
  lawProjectedDate: string | null
  effectiveDate: string | null
  lawNumber: string | null
  expirationDate: string | null
  lawPublicationDate: string | null
  lawPublicationPageNumber: string | null
  lawPublicationVolume: string | null
}

/** GET LegislationDetails/{legislationNumber}. Dates are ISO without zone. */
export interface LimsLegislationDetails {
  legislationId: number
  legislationNumber: string
  councilPeriodId: number
  category: string
  subCategory: string | null
  title: string
  shortDescription: string | null
  introductionDate: string | null
  placeOfIntroduction: string | null
  placeRead?: string | null
  introducers: LimsMember[] | null
  coIntroducers: LimsMember[] | null
  coSponsors: LimsMember[] | null
  committeeReferralDate: string | null
  committeesReferredTo: string[] | null
  committeesReferredToWithComments: string[] | null
  introductionPublicationDate?: string | null
  atTheRequestOf?: string | null
  status: string
  legislationDocument: string | null
  committeeReReferral?: unknown
  additionalInformation: string | null
  committeeHearing: LimsCommitteeHearing[] | null
  committeeMarkup: LimsCommitteeMarkup[] | null
  actions: LimsAction[] | null
  mayoralReview: LimsMayoralReview | null
  congressionalReview: LimsCongressionalReview | null
  vendorName?: string | null
  withdrawnBy: string | null
  withdrawnDate: string | null
  linkedLegislation: unknown[] | null
  resolutionDetails?: unknown
  otherDocuments: LimsDocument[] | null
}

/** GET Members/{councilPeriodId}. */
export interface LimsCouncilMember {
  id: number
  name: string        // "Zachary Parker"
  firstName: string | null
  lastName: string | null
  middleName: string | null
  title: string       // "Councilmember" | "Chairman"
  startDate: string | null
  endDate: string | null
}

/**
 * `onRequest` fires once per actual outbound HTTP attempt (see
 * `rateLimitedFetch`), so call-log rows record egress, not intent.
 */
async function limsFetch(
  path: string,
  apiKey: string,
  init: { method?: 'GET' | 'POST'; body?: unknown } = {},
  onRequest?: () => void,
): Promise<unknown> {
  const method = init.method ?? 'GET'
  const res = await rateLimitedFetch(BASE_URL + path, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json',
      ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(method === 'POST' ? { body: JSON.stringify(init.body ?? {}) } : {}),
  }, { ratePerSec: LIMS_RATE_PER_SEC, bucketKey: 'lims', onRequest })
  if (!res.ok) throw new Error(`LIMS HTTP ${res.status} for ${path}`)
  const body = await res.text()
  try {
    return JSON.parse(body)
  } catch {
    throw new Error(`LIMS ${path}: the response isn't JSON`)
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

// Each check needs the key present, with null allowed. A missing key isn't
// read as null: if LIMS renamed one, every measure would quietly lose that
// field (its sponsors, say) on its next ingest.
const hasText = (o: Record<string, unknown>, key: string) => Object.hasOwn(o, key) && (o[key] === null || typeof o[key] === 'string')
const hasList = (o: Record<string, unknown>, key: string) => Object.hasOwn(o, key) && (o[key] === null || Array.isArray(o[key]))
const hasRecord = (o: Record<string, unknown>, key: string) => Object.hasOwn(o, key) && (o[key] === null || isObject(o[key]))

function unexpected(path: string, what: string): Error {
  return new Error(`LIMS ${path}: unexpected response (${what})`)
}

export async function getCouncilPeriods(apiKey: string, onRequest?: () => void): Promise<LimsCouncilPeriod[]> {
  const data = await limsFetch('CouncilPeriods', apiKey, {}, onRequest)
  if (!Array.isArray(data)) throw unexpected('CouncilPeriods', 'not a list')
  for (const p of data) {
    if (!isObject(p) || typeof p.councilPeriodId !== 'number' || typeof p.startDate !== 'string' || typeof p.endDate !== 'string') {
      throw unexpected('CouncilPeriods', 'a period without its id and dates')
    }
  }
  return data as LimsCouncilPeriod[]
}

/**
 * Every measure of one category in one Council Period. Refreshed by LIMS
 * daily. LIMS answers a category with no measures with `null`.
 */
export async function getBulkData(
  categoryId: number,
  councilPeriodId: number,
  apiKey: string,
  onRequest?: () => void,
): Promise<LimsBulkRecord[]> {
  const path = `BulkData/${categoryId}/${councilPeriodId}`
  const data = await limsFetch(path, apiKey, { method: 'POST' }, onRequest)
  if (data === null) return []
  if (!Array.isArray(data)) throw unexpected(path, 'not a list')
  for (const rec of data) {
    // A record without its history would hash as changed and wipe the bill's history on ingest.
    if (!isObject(rec) || typeof rec.legislationNumber !== 'string' || !hasText(rec, 'status') || !hasList(rec, 'legislationHistory')) {
      throw unexpected(path, 'a record without its number, status, or history')
    }
    for (const h of (rec.legislationHistory as unknown[] | null) ?? []) {
      if (!isObject(h) || !hasText(h, 'actionDate') || !hasText(h, 'actionDescription') || !hasText(h, 'downloadURL')) {
        throw unexpected(path, `a history entry of ${rec.legislationNumber} that isn't one`)
      }
    }
  }
  return data as LimsBulkRecord[]
}

// What the mapping reads from LegislationDetails, which must be present
// (null allowed). linkedLegislation isn't here: the mapping ignores it.
const DETAIL_LISTS = [
  'introducers', 'coIntroducers', 'coSponsors', 'committeesReferredTo', 'committeesReferredToWithComments',
  'committeeHearing', 'committeeMarkup', 'actions', 'otherDocuments',
] as const
const DETAIL_TEXT = ['title', 'shortDescription', 'additionalInformation', 'withdrawnBy', 'withdrawnDate'] as const

/**
 * One measure's details. Anything but the details of the measure asked for
 * throws: the ingest rebuilds the measure from them, replacing its sponsors,
 * votes, and documents, so a short or wrong answer must change nothing.
 */
export async function getLegislationDetails(
  legislationNumber: string,
  apiKey: string,
  onRequest?: () => void,
): Promise<LimsLegislationDetails> {
  const path = `LegislationDetails/${encodeURIComponent(legislationNumber)}`
  const data = await limsFetch(path, apiKey, {}, onRequest)
  if (!isObject(data)) throw unexpected(path, 'no details')
  const number = data.legislationNumber
  if (typeof number !== 'string' || number.trim().toUpperCase() !== legislationNumber.trim().toUpperCase()) {
    throw unexpected(path, `the details of ${JSON.stringify(number ?? null)}`)
  }
  if (typeof data.status !== 'string') throw unexpected(path, 'no status')
  for (const key of DETAIL_LISTS) {
    if (!hasList(data, key) || ((data[key] as unknown[] | null) ?? []).some(item => item === null || item === undefined)) {
      throw unexpected(path, `${key} isn't a list`)
    }
  }
  for (const key of DETAIL_TEXT) if (!hasText(data, key)) throw unexpected(path, `${key} isn't text`)
  for (const key of ['mayoralReview', 'congressionalReview']) {
    if (!hasRecord(data, key)) throw unexpected(path, `${key} isn't an object`)
  }
  return data as unknown as LimsLegislationDetails
}

/**
 * The Council Period's members. A `null` answer, as BulkData gives for an
 * empty category (a period not yet seated, say), is read as none, so it
 * doesn't stop the sync.
 */
export async function getMembers(councilPeriodId: number, apiKey: string, onRequest?: () => void): Promise<LimsCouncilMember[]> {
  const path = `Members/${councilPeriodId}`
  const data = await limsFetch(path, apiKey, {}, onRequest)
  if (data === null) return []
  if (!Array.isArray(data)) throw unexpected(path, 'not a list')
  for (const m of data) {
    if (!isObject(m) || typeof m.id !== 'number' || typeof m.name !== 'string') throw unexpected(path, 'a member without an id and name')
  }
  return data as LimsCouncilMember[]
}
