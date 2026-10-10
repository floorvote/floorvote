import { rateLimitedFetch, sha256Hex, type BodyEvent, type CalendarKind } from '../sdk'
import { clean, committeeKey, referralParts } from './map'

/**
 * The DC Council's own calendar: every committee hearing, roundtable,
 * performance and budget oversight hearing, mark-up, legislative meeting,
 * and breakfast meeting, with its time, room, and agenda. Most have no bill
 * on the agenda, which is why the bill-by-bill calendar can't supply them.
 *
 * This is the feed behind the Council's Hearings Management System
 * (lims.dccouncil.gov/hearings), outside the documented LIMS API, and it
 * needs no key. An undocumented feed is allowed only where its failure
 * changes nothing (#283), so every call fails closed: an HTTP error, a body
 * that isn't JSON, or a shape the mapping doesn't read throws, and core leaves
 * that month as it was. A key the mapping reads must be present, though it
 * may be null. An empty month is returned as empty, and core reads it as no
 * evidence that anything went away. The shape is taken from live responses,
 * recorded in test/fixtures/lims/hearings-calendar.json. hearingsInventory
 * (inventory.ts) says what the mapping does with each field.
 *
 * Adapted from #217 by @anotherpanacea.
 */
const HEARINGS_URL = 'https://lims.dccouncil.gov/Hearings/API/Public/GetHearingsCalendar'

/** The Council's zone. Times in the feed are local, with no offset. */
const DC_ZONE = 'America/New_York'

export interface LimsHearingTopic {
  hearingTopicId: number
  topic: string | null
  /** A measure number, such as "B26-0038", when the topic is a measure. */
  legislationNumber: string | null
}

/** One event in the hearings calendar. */
export interface LimsHearing {
  hearingId: number
  /** "2026-10-07T12:00:00", DC local time. Midnight means no time was set. */
  hearingDateTime: string
  /** The committee's short name ("Youth Affairs"), "Committee of the Whole", or "Legislative Meeting". */
  hearingTitle: string | null
  /** "Hearing", "Roundtable", "Meeting", "Performance Oversight Hearing", "Budget Oversight Hearing", ... */
  hearingType: string | null
  location: string | null
  /** "Joint with Facilities", or "". */
  jointHearingCommittees: string | null
  topics: LimsHearingTopic[] | null
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const hasText = (o: Record<string, unknown>, key: string) => Object.hasOwn(o, key) && (o[key] === null || typeof o[key] === 'string')

/**
 * Every event the calendar lists for one month (1 to 12). Throws on anything
 * but a list of events in the shape the mapping reads.
 */
export async function getHearingsCalendar(month: number, year: number, onRequest?: () => void): Promise<LimsHearing[]> {
  const where = `${year}-${String(month).padStart(2, '0')}`
  const unexpected = (what: string) => new Error(`LIMS hearings calendar ${where}: unexpected response (${what})`)
  const res = await rateLimitedFetch(HEARINGS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ month: String(month), year: String(year), committeeId: 0, searchText: '' }),
  }, { ratePerSec: 1, bucketKey: 'lims', onRequest })
  if (!res.ok) throw new Error(`LIMS hearings calendar HTTP ${res.status} for ${where}`)
  let data: unknown
  try {
    data = JSON.parse(await res.text())
  } catch {
    throw new Error(`LIMS hearings calendar ${where}: the response isn't JSON`)
  }
  if (!Array.isArray(data)) throw unexpected('not a list')
  for (const h of data) {
    if (!isObject(h) || !Number.isInteger(h.hearingId) || typeof h.hearingDateTime !== 'string'
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(h.hearingDateTime)) {
      throw unexpected('an event without its id and date')
    }
    for (const key of ['hearingTitle', 'hearingType', 'location', 'jointHearingCommittees']) {
      if (!hasText(h, key)) throw unexpected(`${key} of event ${h.hearingId} isn't text`)
    }
    if (!Object.hasOwn(h, 'topics') || (h.topics !== null && !Array.isArray(h.topics))) throw unexpected(`topics of event ${h.hearingId} isn't a list`)
    for (const t of (h.topics as unknown[] | null) ?? []) {
      if (!isObject(t) || !hasText(t, 'topic') || !hasText(t, 'legislationNumber')) throw unexpected(`a topic of event ${h.hearingId} that isn't one`)
    }
  }
  return data as LimsHearing[]
}

/** The public page for an event, which links its witness list and testimony sign-up. */
export function hearingUrl(hearingId: number | string): string {
  return `https://lims.dccouncil.gov/Hearings/hearings/${hearingId}`
}

/**
 * The calendar UID instances give a Council event, which is the one the
 * contributor's fork already gave Council hearings on its instances' calendars
 * (#217), so a fork's subscribers see no change when it moves to upstream.
 */
export function hearingUid(hearingId: string): string {
  return `council-${hearingId}@lims.dccouncil.gov`
}

/** An event's kind, from its type: a mark-up, another meeting, or else a hearing (roundtables and oversight hearings too). */
export function hearingKind(type: string): CalendarKind {
  if (/mark-?up/i.test(type)) return 'markup'
  if (/meeting/i.test(type)) return 'meeting'
  return 'hearing'
}

/**
 * The committee holding an event, in the Council's own form, which is the
 * name LIMS referrals carry ("Health" is "Committee on Health"), or null for
 * a legislative or breakfast meeting of the whole Council.
 */
export function hearingCommittee(title: string): string | null {
  if (!title || /^(legislative meeting|council)$/i.test(title)) return null
  return referralParts(title)[0] ?? null
}

/** The event as the mapping reads it, before committee ids. */
interface MappedHearing {
  event: Omit<BodyEvent, 'committee'>
  committee: string | null
}

/**
 * One event, mapped. The hash is the one #217 stored for the event, over the
 * same values, so an instance that took the event from a fork's central keeps
 * its ICS sequence.
 */
export async function mapHearing(h: LimsHearing): Promise<MappedHearing> {
  const date = h.hearingDateTime.slice(0, 10)
  const hhmm = h.hearingDateTime.slice(11, 16)
  const time = /^\d{2}:\d{2}$/.test(hhmm) && hhmm !== '00:00' ? hhmm : null
  const type = clean(h.hearingType) || 'Hearing'
  const body = clean(h.hearingTitle) || 'Council'
  const jointWith = clean(h.jointHearingCommittees) || null
  const location = clean(h.location) || null
  const topics = (h.topics ?? []).map(t => ({ topic: clean(t.topic), number: clean(t.legislationNumber) || null }))
  const eventHash = (await sha256Hex(JSON.stringify([date, time, type, body, jointWith, location, JSON.stringify(topics)]))).slice(0, 32)
  return {
    event: {
      event_id: String(h.hearingId),
      kind: hearingKind(type),
      type,
      date,
      time,
      timezone: DC_ZONE,
      joint_with: jointWith,
      location,
      // "Youth Affairs roundtable", or "Legislative Meeting".
      title: /^legislative meeting$/i.test(body) ? body : `${body} ${type.toLowerCase()}`,
      agenda: topics.map(t => ({ topic: t.topic, bill_number: t.number })),
      url: hearingUrl(h.hearingId),
      event_hash: eventHash,
    },
    committee: hearingCommittee(body),
  }
}

/**
 * Every event dated from `from` to `to`, one calendar call per month, with
 * each committee's central id minted as referrals mint theirs
 * (assignCommitteeIds in map.ts), so both point at one committees row.
 */
export async function limsBodyEvents(
  range: { from: string; to: string },
  ids: (kind: string, nativeKeys: readonly string[]) => Promise<Map<string, number>>,
  logCall: (callType: string, params: Record<string, unknown>) => void,
): Promise<BodyEvent[]> {
  const mapped: MappedHearing[] = []
  let year = Number(range.from.slice(0, 4))
  let month = Number(range.from.slice(5, 7))
  while (`${year}-${String(month).padStart(2, '0')}` <= range.to.slice(0, 7)) {
    const y = year, m = month
    for (const h of await getHearingsCalendar(m, y, () => logCall('lims:HearingsCalendar', { year: y, month: m }))) {
      const one = await mapHearing(h)
      if (range.from <= one.event.date && one.event.date <= range.to) mapped.push(one)
    }
    month = month === 12 ? 1 : month + 1
    if (month === 1) year++
  }
  const names = [...new Set(mapped.map(m => m.committee).filter((n): n is string => !!n))]
  const byKey = names.length > 0 ? await ids('committee', names.map(committeeKey)) : new Map<string, number>()
  return mapped.map(({ event, committee }) => {
    const committeeId = committee ? byKey.get(committeeKey(committee)) : undefined
    return { ...event, committee: committee && committeeId ? { committee_id: committeeId, name: committee, chamber: 'C' } : null }
  })
}
