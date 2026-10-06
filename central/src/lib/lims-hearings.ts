import { rateLimitedFetch } from './rateLimitedFetch'

/**
 * The DC Council's hearing calendar: every committee hearing, roundtable,
 * performance and budget oversight hearing, mark-up, legislative meeting, and
 * breakfast meeting, with its time, room, and agenda topics.
 *
 * This is the feed behind the Council's own Hearings Management System
 * (lims.dccouncil.gov/hearings), not part of the documented LIMS public API. It
 * needs no key. Most of what an advocacy team prepares for (oversight and budget
 * hearings, legislative meetings) has no bill attached, so the bill-by-bill
 * calendar in LegislationDetails cannot supply it. The shape below is taken from
 * live responses; if the Council changes it, getHearingsCalendar throws and the
 * sync skips the month.
 */
const BASE = 'https://lims.dccouncil.gov/Hearings/API/Public/'
const RATE_PER_SEC = 1

export interface CouncilHearingTopic {
  hearingTopicId: number
  topic: string
  /** A measure number such as "B26-0038" when the topic is a bill or resolution. */
  legislationNumber: string | null
}

export interface CouncilHearing {
  hearingId: number
  /** "2026-10-07T12:00:00", DC local time. */
  hearingDateTime: string
  /** The committee, or "Legislative Meeting" / "Committee of the Whole". */
  hearingTitle: string
  /** "Hearing", "Roundtable", "Meeting", "Performance Oversight Hearing", "Budget Oversight Hearing", ... */
  hearingType: string
  location: string | null
  locationAddress: string | null
  jointHearingCommittees: string | null
  witnessesCount: number | null
  topics: CouncilHearingTopic[]
  witnessListAttachment: { attachmentGuid: string; attachmentName: string } | null
}

/** Public page for a hearing, which also links to testimony sign-up. */
export function councilHearingUrl(hearingId: number): string {
  return `https://lims.dccouncil.gov/Hearings/hearings/${hearingId}`
}

export async function getHearingsCalendar(
  month: number,
  year: number,
  onRequest?: () => void,
): Promise<CouncilHearing[]> {
  const res = await rateLimitedFetch(`${BASE}GetHearingsCalendar`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ month: String(month), year: String(year), committeeId: 0, searchText: '' }),
  }, { ratePerSec: RATE_PER_SEC, onRequest })
  if (!res.ok) throw new Error(`Council hearings calendar HTTP ${res.status} for ${year}-${month}`)
  const data = await res.json() as unknown
  if (!Array.isArray(data)) throw new Error(`Council hearings calendar returned a non-array for ${year}-${month}`)
  return data as CouncilHearing[]
}
