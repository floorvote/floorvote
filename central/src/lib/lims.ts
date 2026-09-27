import { rateLimitedFetch } from './rateLimitedFetch'

/**
 * Client for the DC Council Legislative Information Management System (LIMS)
 * public API, v2. https://lims.dccouncil.gov/api/help/index.html
 *
 * Auth is a developer key sent as a Bearer token. The response shapes below are
 * taken from live responses: the published OpenAPI document declares request
 * shapes and some view models, but not the BulkData or SearchLegislation
 * responses.
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

export interface LimsCategory {
  categoryId: number
  name: string
  mobileTitle: string
}

/** One history row inside a BulkData record. Dates are "Jan 06, 2025". */
export interface LimsBulkHistoryEntry {
  legislationNumber: string
  actionDate: string
  actionDescription: string
  downloadURL: string
}

/** One record from POST BulkData/{categoryId}/{councilPeriodId}. */
export interface LimsBulkRecord {
  legislationNumber: string        // "B26-0400"
  legislationCategory: string      // "Bill"
  legislationSubCategory: string   // "Permanent Bill"
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

/** GET LegislationDetails/{legislationNumber}. Dates are ISO without zone. */
export interface LimsLegislationDetails {
  legislationId: number
  legislationNumber: string
  councilPeriodId: number
  category: string
  subCategory: string
  title: string
  shortDescription: string | null
  introductionDate: string | null
  placeOfIntroduction: string | null
  introducers: LimsMember[] | null
  coIntroducers: LimsMember[] | null
  coSponsors: LimsMember[] | null
  committeeReferralDate: string | null
  committeesReferredTo: string[] | null
  committeesReferredToWithComments: string[] | null
  status: string
  legislationDocument: string | null
  additionalInformation: string | null
  committeeHearing: LimsCommitteeHearing[] | null
  committeeMarkup: LimsCommitteeMarkup[] | null
  actions: LimsAction[] | null
  mayoralReview: Record<string, string | null> | null
  congressionalReview: Record<string, string | null> | null
  withdrawnBy: string | null
  withdrawnDate: string | null
  linkedLegislation: unknown[] | null
  otherDocuments: LimsDocument[] | null
}

/**
 * `onRequest` fires once per actual outbound HTTP attempt (see
 * `rateLimitedFetch`), so call-log rows record egress, not intent.
 */
async function limsFetch<T>(
  path: string,
  apiKey: string,
  init: { method?: 'GET' | 'POST'; body?: unknown } = {},
  onRequest?: () => void,
): Promise<T> {
  const method = init.method ?? 'GET'
  const res = await rateLimitedFetch(BASE_URL + path, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json',
      ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(method === 'POST' ? { body: JSON.stringify(init.body ?? {}) } : {}),
  }, { ratePerSec: LIMS_RATE_PER_SEC, onRequest })
  if (!res.ok) throw new Error(`LIMS HTTP ${res.status} for ${path}`)
  return (await res.json()) as T
}

export function getCouncilPeriods(apiKey: string, onRequest?: () => void): Promise<LimsCouncilPeriod[]> {
  return limsFetch<LimsCouncilPeriod[]>('CouncilPeriods', apiKey, {}, onRequest)
}

export function getLegislationCategories(apiKey: string, onRequest?: () => void): Promise<LimsCategory[]> {
  return limsFetch<LimsCategory[]>('LegislationCategories', apiKey, {}, onRequest)
}

/** Every measure of one category in one Council Period. Refreshed by LIMS daily. */
export async function getBulkData(
  categoryId: number,
  councilPeriodId: number,
  apiKey: string,
  onRequest?: () => void,
): Promise<LimsBulkRecord[]> {
  const data = await limsFetch<LimsBulkRecord[] | null>(
    `BulkData/${categoryId}/${councilPeriodId}`, apiKey, { method: 'POST' }, onRequest)
  return data ?? []
}

export function getLegislationDetails(
  legislationNumber: string,
  apiKey: string,
  onRequest?: () => void,
): Promise<LimsLegislationDetails> {
  return limsFetch<LimsLegislationDetails>(
    `LegislationDetails/${encodeURIComponent(legislationNumber)}`, apiKey, {}, onRequest)
}
