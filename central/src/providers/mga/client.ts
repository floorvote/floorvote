import { rateLimitedFetch } from '../sdk'

/**
 * Client for the Maryland General Assembly's open data: one JSON file per
 * session listing every bill and resolution, with no key.
 * https://mgaleg.maryland.gov/mgawebsite/Legislation/OpenData
 *
 * The file (about 8 MB, regenerated through the day) carries sponsors, status,
 * committees, each chamber's readings and hearing times, subjects and statute
 * citations. Text, fiscal notes and votes are PDFs; the first two sit at paths
 * built from the bill number (see map.ts).
 */
export const MGA_BASE = 'https://mgaleg.maryland.gov'

/** Three or four requests a pass; pacing is a courtesy, not a limit. */
const MGA_RATE_PER_SEC = 1

export interface MgaCode { Code: string; Name: string }

/** One record of {session}/misc/billsmasterlist/legislation.json. Dates are YYYY-MM-DD, times local. */
export interface MgaRecord {
  BillNumber: string                 // "HB0001"
  ChapterNumber: string              // "" or "350"
  CrossfileBillNumber: string        // "" or "SB0002"
  SponsorPrimary: string             // "Delegate Crosby", "Chair, Appropriations Committee"
  Sponsors: { Name: string }[]
  Synopsis: string
  Title: string
  /** The last action, as free text: "In the House - Hearing 2/11 at 1:00 p.m.", "Approved by the Governor - Chapter 350". */
  Status: string
  CommitteePrimaryOrigin: string
  CommitteeSecondaryOrigin: string
  CommitteePrimaryOpposite: string
  CommitteeSecondaryOpposite: string
  FirstReadingDateHouseOfOrigin: string | null
  HearingDateTimePrimaryHouseOfOrigin: string | null     // "2026-01-28T15:00:00"
  HearingDateTimeSecondaryHouseOfOrigin: string | null
  ReportDateHouseOfOrigin: string | null
  ReportActionHouseOfOrigin: string
  SecondReadingDateHouseOfOrigin: string | null
  SecondReadingActionHouseOfOrigin: string
  ThirdReadingDateHouseOfOrigin: string | null
  ThirdReadingActionHouseOfOrigin: string
  FirstReadingDateOppositeHouse: string | null
  HearingDateTimePrimaryOppositeHouse: string | null
  HearingDateTimeSecondaryOppositeHouse: string | null
  ReportDateOppositeHouse: string | null
  ReportActionOppositeHouse: string
  SecondReadingDateOppositeHouse: string | null
  SecondReadingActionOppositeHouse: string
  ThirdReadingDateOppositeHouse: string | null
  ThirdReadingActionOppositeHouse: string
  InteractionBetweenChambers: string
  PassedByMGA: boolean
  EmergencyBill: boolean
  ConstitutionalAmendment: boolean
  BroadSubjects: MgaCode[]
  NarrowSubjects: MgaCode[]
  BillType: string                   // "Pre-Filed", "Regular"
  BillVersion: string                // latest text: "F" first reader, "T" third reader, "E" enrolled
  Statutes: { Article: { Code: string; Title: string | null } | null; Sections: { Section: string | null }[] | null }[] | null
  YearAndSession: string             // "2026 Regular Session"
  /** One timestamp for the whole file; changes on every regeneration. */
  StatusCurrentAsOf: string
}

function sessionUrl(sessionCode: string): string {
  return `${MGA_BASE}/${sessionCode}/misc/billsmasterlist/legislation.json`
}

/** What `getMgaSession` read: the records and the file's ETag, or that the file hasn't changed since the ETag given. */
export type MgaSessionFile =
  | { unchanged: false; records: MgaRecord[]; etag: string | null }
  | { unchanged: true }

/**
 * Every record of one session ("2026RS", "2021S1"), or null when the session
 * has no file yet. With `etag` (the ETag of the last file read in full), the
 * request is conditional, and a file that hasn't changed answers 304 with no
 * body: about 8 MB not downloaded or parsed.
 *
 * Fails closed: an HTTP error, a body that isn't JSON, or a record whose
 * shape isn't what the mapping reads throws, so the sync stops for the hour
 * without writing anything from that answer. An empty list comes back empty,
 * and the sync reads it as nothing new, never as bills removed.
 */
export async function getMgaSession(sessionCode: string, etag?: string | null, onRequest?: () => void): Promise<MgaSessionFile | null> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (etag) headers['If-None-Match'] = etag
  const res = await rateLimitedFetch(sessionUrl(sessionCode), { headers },
    { ratePerSec: MGA_RATE_PER_SEC, bucketKey: 'mga', onRequest })
  if (res.status === 404) return null
  if (res.status === 304 && etag) return { unchanged: true }
  if (!res.ok) throw new Error(`MGA HTTP ${res.status} for ${sessionCode}`)
  let data: unknown
  try {
    data = JSON.parse(await res.text())
  } catch {
    throw new Error(`MGA ${sessionCode}: the session file isn't JSON`)
  }
  // A null body is an empty file, like [].
  if (data === null) return { unchanged: false, records: [], etag: null }
  if (!Array.isArray(data)) throw unexpected(sessionCode, 'not a list')
  for (const record of data) checkRecord(sessionCode, record)
  return { unchanged: false, records: data as MgaRecord[], etag: res.headers.get('ETag') }
}

/** Whether a session's file exists: a regular session appears with its first prefiled bills. */
export async function mgaSessionExists(sessionCode: string, onRequest?: () => void): Promise<boolean> {
  const res = await rateLimitedFetch(sessionUrl(sessionCode), { method: 'HEAD' },
    { ratePerSec: MGA_RATE_PER_SEC, bucketKey: 'mga', onRequest })
  if (res.status === 404) return false
  if (!res.ok) throw new Error(`MGA HTTP ${res.status} for ${sessionCode}`)
  return true
}

function unexpected(sessionCode: string, what: string): Error {
  return new Error(`MGA ${sessionCode}: unexpected session file (${what})`)
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

// Every key the mapping reads, by the type it needs. Each must be present,
// though it may be null: a missing key isn't read as an empty one, or a key
// the MGA renamed would quietly strip that field (sponsors, say) from every
// Maryland bill on its next ingest.
const TEXT_KEYS = [
  'ChapterNumber', 'CrossfileBillNumber', 'SponsorPrimary', 'Synopsis', 'Title', 'Status',
  'CommitteePrimaryOrigin', 'CommitteeSecondaryOrigin', 'CommitteePrimaryOpposite', 'CommitteeSecondaryOpposite',
  'FirstReadingDateHouseOfOrigin', 'HearingDateTimePrimaryHouseOfOrigin', 'HearingDateTimeSecondaryHouseOfOrigin',
  'ReportDateHouseOfOrigin', 'ReportActionHouseOfOrigin', 'SecondReadingDateHouseOfOrigin', 'SecondReadingActionHouseOfOrigin',
  'ThirdReadingDateHouseOfOrigin', 'ThirdReadingActionHouseOfOrigin',
  'FirstReadingDateOppositeHouse', 'HearingDateTimePrimaryOppositeHouse', 'HearingDateTimeSecondaryOppositeHouse',
  'ReportDateOppositeHouse', 'ReportActionOppositeHouse', 'SecondReadingDateOppositeHouse', 'SecondReadingActionOppositeHouse',
  'ThirdReadingDateOppositeHouse', 'ThirdReadingActionOppositeHouse',
  'InteractionBetweenChambers', 'BillVersion',
] as const
const FLAG_KEYS = ['PassedByMGA', 'EmergencyBill', 'ConstitutionalAmendment'] as const
const LIST_KEYS = ['Sponsors', 'BroadSubjects', 'NarrowSubjects', 'Statutes'] as const

const hasText = (o: Record<string, unknown>, key: string) => Object.hasOwn(o, key) && (o[key] === null || typeof o[key] === 'string')
const hasFlag = (o: Record<string, unknown>, key: string) => Object.hasOwn(o, key) && (o[key] === null || typeof o[key] === 'boolean')
const hasList = (o: Record<string, unknown>, key: string) => Object.hasOwn(o, key) && (o[key] === null || Array.isArray(o[key]))
const hasRecord = (o: Record<string, unknown>, key: string) => Object.hasOwn(o, key) && (o[key] === null || isObject(o[key]))
const listOf = (o: Record<string, unknown>, key: string) => (o[key] ?? []) as unknown[]

function checkRecord(sessionCode: string, r: unknown): void {
  if (!isObject(r) || typeof r.BillNumber !== 'string' || !/^[A-Z]+\d+$/.test(r.BillNumber.trim())) {
    throw unexpected(sessionCode, 'a record without its bill number')
  }
  const bill = r.BillNumber
  for (const key of TEXT_KEYS) if (!hasText(r, key)) throw unexpected(sessionCode, `${bill}'s ${key} isn't text`)
  for (const key of FLAG_KEYS) if (!hasFlag(r, key)) throw unexpected(sessionCode, `${bill}'s ${key} isn't true or false`)
  for (const key of LIST_KEYS) if (!hasList(r, key)) throw unexpected(sessionCode, `${bill}'s ${key} isn't a list`)
  if (!listOf(r, 'Sponsors').every(s => isObject(s) && typeof s.Name === 'string')) {
    throw unexpected(sessionCode, `a sponsor of ${bill} without a name`)
  }
  for (const key of ['BroadSubjects', 'NarrowSubjects']) {
    if (!listOf(r, key).every(s => isObject(s) && typeof s.Code === 'string' && typeof s.Name === 'string')) {
      throw unexpected(sessionCode, `a subject of ${bill} without its code and name`)
    }
  }
  const statuteOk = (st: unknown) => isObject(st) && hasRecord(st, 'Article') && hasList(st, 'Sections') &&
    (st.Article === null || hasText(st.Article as Record<string, unknown>, 'Title')) &&
    listOf(st, 'Sections').every(x => isObject(x) && hasText(x, 'Section'))
  if (!listOf(r, 'Statutes').every(statuteOk)) throw unexpected(sessionCode, `a statute of ${bill} without its article and sections`)
}
