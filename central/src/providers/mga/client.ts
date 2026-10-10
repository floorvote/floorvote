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
  Statutes: { Article: { Code: string; Title: string }; Sections: { Section: string }[] }[]
  YearAndSession: string             // "2026 Regular Session"
  /** One timestamp for the whole file; changes on every regeneration. */
  StatusCurrentAsOf: string
}

function sessionUrl(sessionCode: string): string {
  return `${MGA_BASE}/${sessionCode}/misc/billsmasterlist/legislation.json`
}

/** Every record of one session ("2026RS", "2021S1"), or null when the session has no file yet. */
export async function getMgaSession(sessionCode: string, onRequest?: () => void): Promise<MgaRecord[] | null> {
  const res = await rateLimitedFetch(sessionUrl(sessionCode), { headers: { Accept: 'application/json' } },
    { ratePerSec: MGA_RATE_PER_SEC, bucketKey: 'mga', onRequest })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`MGA HTTP ${res.status} for ${sessionCode}`)
  return (await res.json()) as MgaRecord[]
}

/** Whether a session's file exists: a regular session appears with its first prefiled bills. */
export async function mgaSessionExists(sessionCode: string, onRequest?: () => void): Promise<boolean> {
  const res = await rateLimitedFetch(sessionUrl(sessionCode), { method: 'HEAD' },
    { ratePerSec: MGA_RATE_PER_SEC, bucketKey: 'mga', onRequest })
  if (res.status === 404) return false
  if (!res.ok) throw new Error(`MGA HTTP ${res.status} for ${sessionCode}`)
  return true
}
