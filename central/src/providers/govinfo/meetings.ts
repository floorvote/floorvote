import { rateLimitedFetch, sha256Hex, type BodyEvent, type CalendarKind, type MeasureCalendarEntry, type ProviderContext } from '../sdk'
import { BILL_TYPE, govinfoNativeKey, legiscanNumber, ordinal, type CongressBillType } from './map'

/**
 * Committee meetings from the Congress.gov API: the hearings, markups, and
 * meetings of every House, Senate, and joint committee, with the bills each
 * takes up. https://api.congress.gov/ needs a key (an api.data.gov key), which
 * a deployment may or may not set (`CONGRESS_API_KEY`). Without one nothing in
 * this file runs.
 *
 * The API answers a list of meetings and, for each meeting, a detail. The list
 * names only a meeting's event id, chamber, and when it last changed. The
 * meeting's date, committee, bills, and the rest are in its detail, so a
 * Congress's 2,800 meetings are 2,800 requests, and the Library of Congress
 * asks for no more than 10 requests a minute (the pace below, 6 seconds apart).
 * A run can't read them all in the time it has, so each meeting is read once
 * and kept (ProviderContext.cache), and read again only when the list says it
 * changed. A pass reads at most DETAILS_PER_PASS, so the first passes after a
 * key is set fill the calendar in a few hours, newest meetings first.
 *
 * What a pass keeps comes in two steps, so a pass that fails changes nothing
 * anyone sees: what it reads goes under `staged/`, where the next pass finds
 * it and doesn't read it again, and moves to `meeting/` only when the pass
 * finishes. The body calendar (listBodyEvents) and each bill's calendar
 * (the bill sync reads `meeting/`) show only what has moved there.
 *
 * Fails closed: an answer that isn't HTTP 200, isn't JSON, or isn't shaped as
 * described below throws, the pass shows nothing new, and the next pass tries
 * again. One exception: a meeting whose detail can't be read on
 * QUARANTINE_AFTER passes in a row is quarantined (see there), so one bad
 * answer holds the calendar for a few hours, not until it's fixed. The key goes only in the `X-Api-Key` header of a request to
 * api.congress.gov, whose redirects are never followed, and in no address,
 * log, or stored value.
 */
export const CONGRESS_API = 'https://api.congress.gov/v3'

/** The Library of Congress's own ceiling for its applications. One pace and one bucket for every request. */
export const CONGRESS_REQUESTS_PER_MINUTE = 10
const BUCKET = 'congress-gov'

/** The most meetings a list page holds, which the API caps at 250. */
export const LIST_PAGE_SIZE = 250

/**
 * The most meetings one pass reads: 60 requests, a little over six minutes at
 * the pace. With the list's own pages, a pass is under 8 minutes, inside a
 * cron's time. The next pass reads the rest.
 */
export const DETAILS_PER_PASS = 60

/**
 * How many passes in a row a meeting's detail can fail to parse before the
 * meeting is quarantined: 3, about three hours at a pass an hour. Short of it,
 * the pass fails closed, as for any answer it can't read, since one bad answer
 * may be the API caught mid-change and the next pass may read it. From it on,
 * passes go on without the meeting: what is kept of it (its body event and its
 * bills' entries) stays as it was, every pass asks for it again, and it's
 * released the first time it parses. The operators get one alert naming it
 * (ProviderContext.alert). Only an answer that came back and can't be read
 * counts. An answer that isn't 200 is the API failing, not the meeting, and
 * fails the pass closed however long it lasts.
 */
export const QUARANTINE_AFTER = 3

/** More pages than the API could ever need, so a list that never ends fails and doesn't loop. */
const MAX_PAGES = 100

export type MeetingChamber = 'house' | 'senate' | 'nochamber'

/** What the list says of a meeting. */
export interface ListedMeeting { eventId: string; chamber: MeetingChamber; updateDate: string }

/** A meeting, as read from its detail: what a calendar shows of it, and nothing else. */
export interface Meeting {
  /** The API's id for the meeting, which it keeps. */
  eventId: string
  chamber: MeetingChamber
  congress: number
  /** When the API last changed the meeting. */
  updateDate: string
  /** Eastern, YYYY-MM-DD. */
  date: string
  /** Eastern, HH:MM, or null at midnight, which is a feed with no time of day. */
  time: string | null
  /** The API's own type: "Hearing", "Markup", "Meeting", "Open Hearing", "Closed Markup Session", ... */
  type: string
  /** The API's own status: "Scheduled", "Rescheduled", "Postponed", "Canceled", ... */
  status: string
  /** One line, as the API words it (a markup's agenda has line breaks in it). Empty when it has none. */
  title: string
  location: string | null
  /** The committees holding it, in the order given. A committee the API gives no name for has a null name. */
  committees: { systemCode: string; name: string | null }[]
  /** The bills it takes up, once each, in the order given. */
  bills: { type: CongressBillType; number: string }[]
}

const CHAMBERS: Record<string, MeetingChamber> = { House: 'house', Senate: 'senate', NoChamber: 'nochamber' }
const SYSTEM_CODE = /^[a-z]{4}\d{2}$/
const UPDATED = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const clean = (s: string) => s.replace(/\s+/g, ' ').trim()

/** Whether a string is a real UTC time as the API writes one: `2026-09-15T14:15:00Z`, and a day that exists. */
function isUtcTime(s: unknown): s is string {
  if (typeof s !== 'string' || !UPDATED.test(s)) return false
  // Date.parse takes February 31 for March 3, so a real time is one that survives the round trip.
  const t = Date.parse(s)
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 19) + 'Z' === s
}

// ---- Reading the API's answers

/** One page of the list: each meeting's event id, chamber, and update time, and how many meetings the Congress has. */
export function parseMeetingList(text: string, congress: number): { entries: ListedMeeting[]; count: number } {
  const bad = (why: string) => new Error(`Congress.gov meeting list: ${why}`)
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    throw bad('the answer isn\'t JSON')
  }
  if (!isObject(body) || !Array.isArray(body.committeeMeetings)) throw bad('the answer has no committeeMeetings list')
  const count = isObject(body.pagination) ? body.pagination.count : undefined
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) throw bad('the answer has no count of meetings')
  const entries: ListedMeeting[] = []
  const seen = new Set<string>()
  for (const m of body.committeeMeetings as unknown[]) {
    if (!isObject(m)) throw bad('a listed meeting isn\'t an object')
    if (typeof m.eventId !== 'string' || !/^\d+$/.test(m.eventId)) throw bad(`a listed meeting has an event id that isn't a number (${JSON.stringify(m.eventId ?? null)})`)
    const id = m.eventId
    if (typeof m.chamber !== 'string' || !Object.hasOwn(CHAMBERS, m.chamber)) throw bad(`meeting ${id} is in a chamber that isn't House, Senate, or NoChamber (${JSON.stringify(m.chamber ?? null)})`)
    if (m.congress !== congress) throw bad(`meeting ${id} is from Congress ${String(m.congress)}, not ${congress}`)
    if (!isUtcTime(m.updateDate)) throw bad(`meeting ${id} has no updateDate`)
    if (seen.has(id)) throw bad(`meeting ${id} is listed twice on one page`)
    seen.add(id)
    entries.push({ eventId: id, chamber: CHAMBERS[m.chamber], updateDate: m.updateDate })
  }
  return { entries, count }
}

/**
 * One meeting, from its detail answer. `listed` is what the list said of it,
 * which the answer must agree with (the same event, in the same chamber).
 */
export function parseMeeting(text: string, listed: ListedMeeting, congress: number): Meeting {
  const bad = (why: string) => new Error(`Congress.gov meeting ${listed.eventId}: ${why}`)
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    throw bad('the answer isn\'t JSON')
  }
  const m = isObject(body) ? body.committeeMeeting : undefined
  if (!isObject(m)) throw bad('the answer has no committeeMeeting')

  if (typeof m.eventId !== 'string' || !/^\d+$/.test(m.eventId)) throw bad(`it has no event id (${JSON.stringify(m.eventId ?? null)})`)
  if (m.eventId !== listed.eventId) throw bad(`it is for event ${m.eventId}`)
  if (m.congress !== congress) throw bad(`it is from Congress ${String(m.congress)}, not ${congress}`)
  const chamber = typeof m.chamber === 'string' ? CHAMBERS[m.chamber] : undefined
  if (!chamber) throw bad(`its chamber isn't House, Senate, or NoChamber (${JSON.stringify(m.chamber ?? null)})`)
  if (chamber !== listed.chamber) throw bad(`its chamber is ${m.chamber}, and the list put it in the ${listed.chamber === 'nochamber' ? 'joint' : listed.chamber}`)
  if (!isUtcTime(m.date)) throw bad(`its date isn't a UTC time (${JSON.stringify(m.date ?? null)})`)
  if (typeof m.meetingStatus !== 'string' || !clean(m.meetingStatus)) throw bad('it has no meetingStatus')
  if (typeof m.type !== 'string' || !clean(m.type)) throw bad('it has no type')
  if (m.title !== undefined && typeof m.title !== 'string') throw bad('its title isn\'t text')
  if (!isUtcTime(m.updateDate)) throw bad('it has no updateDate')

  const { date, time } = easternTime(m.date)
  return {
    eventId: m.eventId,
    chamber,
    congress,
    updateDate: m.updateDate,
    date,
    time,
    type: clean(m.type),
    status: clean(m.meetingStatus),
    title: clean((m.title as string | undefined) ?? ''),
    location: readLocation(m.location, bad),
    committees: readCommittees(m.committees, bad),
    bills: readBills(m.relatedItems, congress, bad),
  }
}

function readCommittees(value: unknown, bad: (why: string) => Error): Meeting['committees'] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw bad('its committees aren\'t a list')
  return value.map(c => {
    if (!isObject(c)) throw bad('a committee isn\'t an object')
    if (typeof c.systemCode !== 'string' || !SYSTEM_CODE.test(c.systemCode)) throw bad(`a committee has a system code that isn't one (${JSON.stringify(c.systemCode ?? null)})`)
    if (c.name !== undefined && typeof c.name !== 'string') throw bad(`committee ${c.systemCode}'s name isn't text`)
    return { systemCode: c.systemCode, name: clean(c.name ?? '') || null }
  })
}

/**
 * Where the meeting is: the room and building (`2175 Rayburn House Office
 * Building`), or, for a field hearing, an address the API gives as JSON in a
 * string (`{"building_name": ..., "street-address": ..., "city": ...}`).
 */
function readLocation(value: unknown, bad: (why: string) => Error): string | null {
  if (value === undefined) return null
  if (!isObject(value)) throw bad('its location isn\'t an object')
  for (const key of ['building', 'room', 'address']) {
    if (value[key] !== undefined && typeof value[key] !== 'string') throw bad(`its location's ${key} isn't text`)
  }
  const room = clean((value.room as string | undefined) ?? '')
  const building = clean((value.building as string | undefined) ?? '')
  if (room || building) return [room, building].filter(Boolean).join(' ')
  const address = clean((value.address as string | undefined) ?? '')
  if (!address) return null
  try {
    const a: unknown = JSON.parse(address)
    if (isObject(a)) {
      const text = (key: string) => (typeof a[key] === 'string' ? clean(a[key] as string) : '')
      const cityState = [text('city'), [text('state'), text('postal_code')].filter(Boolean).join(' ')].filter(Boolean).join(', ')
      const parts = [text('building_name'), text('street-address'), cityState].filter(Boolean)
      if (parts.length > 0) return parts.join(', ')
    }
  } catch {
    // Not JSON: it is the address.
  }
  return address
}

function readBills(value: unknown, congress: number, bad: (why: string) => Error): Meeting['bills'] {
  if (value === undefined) return []
  if (!isObject(value)) throw bad('its relatedItems isn\'t an object')
  if (value.bills === undefined) return []
  if (!Array.isArray(value.bills)) throw bad('its bills aren\'t a list')
  const out: Meeting['bills'] = []
  const seen = new Set<string>()
  for (const b of value.bills as unknown[]) {
    if (!isObject(b)) throw bad('a bill isn\'t an object')
    const number = typeof b.number === 'number' && Number.isInteger(b.number) ? String(b.number) : b.number
    if (typeof number !== 'string' || !/^[1-9]\d*$/.test(number)) throw bad(`a bill has no number (${JSON.stringify(b.number ?? null)})`)
    if (typeof b.type !== 'string' || !Object.hasOwn(BILL_TYPE, b.type)) throw bad(`a bill is of a type that isn't one of Congress's eight (${JSON.stringify(b.type ?? null)})`)
    if (b.congress !== congress) throw bad(`a bill is from Congress ${String(b.congress)}, not ${congress}`)
    const key = `${b.type}${number}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ type: b.type as CongressBillType, number })
  }
  return out
}

const EASTERN = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
})

/**
 * The date and time in Washington of a UTC time, in whichever season it falls.
 * Midnight has no time: it is how a feed with no time of day says so.
 */
export function easternTime(utc: string): { date: string; time: string | null } {
  const part: Record<string, string> = {}
  for (const p of EASTERN.formatToParts(new Date(utc))) part[p.type] = p.value
  const time = `${part.hour}:${part.minute}`
  return { date: `${part.year}-${part.month}-${part.day}`, time: time === '00:00' ? null : time }
}

/** Whether a status says the meeting won't happen. "Scheduled" says nothing of the past, and "Rescheduled" is a meeting that moved. */
export function isCancelled(status: string): boolean {
  return /^(canceled|cancelled|postponed)$/i.test(status.trim())
}

/**
 * A meeting's event type in the vocabulary, and so its kind, from the API's
 * own type. The API's types are many ("Open Hearing", "Closed Markup
 * Session", "Open Business Meeting"), so the words decide: a markup, else a
 * hearing, else a meeting. A type with none of them is a meeting, the
 * kind that claims least.
 */
export function meetingType(type: string): { typeId: number; kind: CalendarKind } {
  const t = clean(type).toLowerCase()
  if (/mark-?up/.test(t)) return { typeId: 2, kind: 'markup' }
  if (/hearing/.test(t)) return { typeId: 1, kind: 'hearing' }
  return { typeId: 3, kind: 'meeting' }
}

// ---- Requests

function listUrl(congress: number, offset: number, since?: string): string {
  return `${CONGRESS_API}/committee-meeting/${congress}?format=json&limit=${LIST_PAGE_SIZE}&offset=${offset}${since ? `&fromDateTime=${since}` : ''}`
}

function detailUrl(congress: number, listed: ListedMeeting): string {
  return `${CONGRESS_API}/committee-meeting/${congress}/${listed.chamber}/${listed.eventId}?format=json`
}

/** The body of a 200 answer from the API. Anything else, a redirect and a 429 included, throws. */
async function get(url: string, key: string, onRequest: () => void, what: string): Promise<string> {
  try {
    // A redirect isn't followed: the key goes to api.congress.gov and nowhere else. And a 429 isn't retried,
    // since its Retry-After may be an hour, and a pass that waits an hour for it blocks the others.
    const res = await rateLimitedFetch(url, { headers: { Accept: 'application/json', 'X-Api-Key': key }, redirect: 'manual' },
      { ratePerSec: CONGRESS_REQUESTS_PER_MINUTE / 60, bucketKey: BUCKET, maxRetries: 0, onRequest })
    if (res.status !== 200) {
      await res.body?.cancel().catch(() => {})
      throw new Error(`HTTP ${res.status}`)
    }
    return await res.text()
  } catch (err) {
    throw new Error(`${what}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

type Context = Pick<ProviderContext, 'cache' | 'logCall' | 'today' | 'alert'>

/** How far before a read began the second look at the list reaches, so a meeting changed as the read began is in it. */
const SINCE_MARGIN_MS = 10 * 60 * 1000

/** The pages of the list, or, with `since`, of the meetings changed since then: each meeting once, and the count the last page gave. */
async function readPages(ctx: Context, key: string, congress: number, since?: string): Promise<{ meetings: Map<string, ListedMeeting>; count: number }> {
  const meetings = new Map<string, ListedMeeting>()
  let count = 0
  for (let page = 0, offset = 0; ; page++, offset += LIST_PAGE_SIZE) {
    if (page >= MAX_PAGES) throw new Error(`Congress.gov meeting list: more than ${MAX_PAGES} pages`)
    const text = await get(listUrl(congress, offset, since), key,
      () => ctx.logCall('govinfo:CongressMeetingList', { congress, offset, ...(since ? { since } : {}) }), `Congress.gov meeting list (offset ${offset})`)
    const parsed = parseMeetingList(text, congress)
    count = parsed.count
    // A meeting changed while the list is read moves up it, and may be on two pages: the later read is the newer.
    for (const e of parsed.entries) meetings.set(e.eventId, e)
    if (offset + LIST_PAGE_SIZE >= count) break
    if (parsed.entries.length === 0) throw new Error(`Congress.gov meeting list: it ends at ${meetings.size} of ${count} meetings`)
  }
  return { meetings, count }
}

/**
 * Every meeting the list names for a Congress. The list is paged newest update
 * first, and takes a pass of a minute or more to read, so a meeting changed
 * meanwhile moves to the front, after pages already read, and a page read later
 * misses it. So a second look follows the pages: the meetings changed since a
 * little before the read began, merged over them, the newer answer winning. Short
 * of the count the last page gave even then, the list isn't whole, and it throws.
 */
async function readList(ctx: Context, key: string, congress: number): Promise<ListedMeeting[]> {
  const began = Date.now()
  const { meetings, count } = await readPages(ctx, key, congress)
  const since = new Date(began - SINCE_MARGIN_MS).toISOString().slice(0, 19) + 'Z'
  for (const [id, e] of (await readPages(ctx, key, congress, since)).meetings) meetings.set(id, e)
  if (meetings.size < count) throw new Error(`Congress.gov meeting list: it names ${meetings.size} meetings, short of its count of ${count}; it changed while it was read`)
  return [...meetings.values()]
}

// ---- What is kept

const COMMITTED = (congress: number) => `meeting/${congress}/`
const STAGED = (congress: number) => `staged/${congress}/`
/** Present once a finished pass has found no meeting that was never read, but a quarantined one: the first full read is done. */
const WARM = (congress: number) => `warm/${congress}`
/** For a meeting whose detail has failed to parse: on how many passes in a row, and whether the operators were alerted. */
const FAILING = (congress: number) => `failing/${congress}/`

/**
 * Whether every meeting of the Congress has been read once. Until it has, a
 * bill's calendar can't say it has no meeting, since the meeting may be one not
 * read yet, so the bill sync attaches none and a bill's ingest sends no calendar
 * (which core takes as no word on the entries the bill has, a cut-over bill's
 * carried hearings among them).
 */
export async function isWarm(ctx: Pick<ProviderContext, 'cache'>, congress: number): Promise<boolean> {
  return (await ctx.cache.list(WARM(congress))).has(WARM(congress))
}

/** A meeting as kept, with the update time the list gave when it was read (which may differ in form from the meeting's own). */
interface Kept { seen: string; meeting: Meeting }

function keep(k: Kept): string {
  return JSON.stringify(k)
}

function readKept(value: string, congress: number): Kept | null {
  try {
    const k = JSON.parse(value) as unknown
    if (!isObject(k) || typeof k.seen !== 'string' || !isObject(k.meeting)) return null
    const m = k.meeting
    if (typeof m.eventId !== 'string' || m.congress !== congress || typeof m.date !== 'string' || !Array.isArray(m.committees) || !Array.isArray(m.bills)
      || typeof m.type !== 'string' || typeof m.status !== 'string' || typeof m.title !== 'string') return null
    return { seen: k.seen, meeting: m as unknown as Meeting }
  } catch {
    return null
  }
}

/** What a prefix of the cache holds, by event id. An entry that can't be read is left out, and so read again. */
async function keptUnder(ctx: Pick<ProviderContext, 'cache'>, prefix: string, congress: number): Promise<{ kept: Map<string, Kept>; unreadable: string[] }> {
  const kept = new Map<string, Kept>()
  const unreadable: string[] = []
  for (const [key, value] of await ctx.cache.list(prefix)) {
    const k = readKept(value, congress)
    if (k && key === `${prefix}${k.meeting.eventId}`) kept.set(k.meeting.eventId, k)
    else unreadable.push(key)
  }
  return { kept, unreadable }
}

/** A meeting that fails to parse, as kept: the passes in a row it has failed on, and whether it was alerted on. */
interface Failing { strikes: number; alerted: boolean }

/** The meetings failing to parse, by event id, and the keys of entries that can't be read (as good as none: they are dropped). */
async function failingMeetings(ctx: Pick<ProviderContext, 'cache'>, congress: number): Promise<{ failing: Map<string, Failing>; unreadable: string[] }> {
  const failing = new Map<string, Failing>()
  const unreadable: string[] = []
  for (const [key, value] of await ctx.cache.list(FAILING(congress))) {
    const id = key.slice(FAILING(congress).length)
    let f: unknown
    try {
      f = JSON.parse(value)
    } catch {
      f = null
    }
    if (/^\d+$/.test(id) && isObject(f) && typeof f.strikes === 'number' && Number.isInteger(f.strikes) && f.strikes > 0 && typeof f.alerted === 'boolean') {
      failing.set(id, { strikes: f.strikes, alerted: f.alerted })
    } else unreadable.push(key)
  }
  return { failing, unreadable }
}

/**
 * Every meeting a pass has moved to `meeting/`, for the bill sync, which reads
 * only these. Nothing is requested.
 */
export async function keptMeetings(ctx: Pick<ProviderContext, 'cache'>, congress: number): Promise<Meeting[]> {
  return [...(await keptUnder(ctx, COMMITTED(congress), congress)).kept.values()].map(k => k.meeting)
}

// ---- One pass

/** How long one pass's answer is reused, so the five months the body calendar asks for are one read of the API. */
const PASS_MS = 10 * 60 * 1000
/** And how long its failure is, so they are one failure and not five. */
const FAILED_MS = 2 * 60 * 1000

let lastPass: { at: number; ok: boolean; result: Promise<Meeting[]> } | null = null

/** Forget the pass in memory. For tests: a real pass in a new isolate finds none. */
export function clearMeetingCaches(): void {
  lastPass = null
}

/** The ids to read, most worth reading first: meetings changed since read, the nearest to today first, then new ones, the highest event id first. */
function readOrder(todayMs: number, listed: ListedMeeting[], committed: Map<string, Kept>, have: (l: ListedMeeting) => boolean): ListedMeeting[] {
  const need = listed.filter(l => !have(l))
  const changed = need.filter(l => committed.has(l.eventId))
    .map(l => ({ l, away: Math.abs(Date.parse(`${committed.get(l.eventId)!.meeting.date}T12:00:00Z`) - todayMs) }))
    .sort((a, b) => a.away - b.away || Number(b.l.eventId) - Number(a.l.eventId))
    .map(x => x.l)
  const fresh = need.filter(l => !committed.has(l.eventId)).sort((a, b) => Number(b.eventId) - Number(a.eventId))
  return [...changed, ...fresh]
}

/**
 * The Congress's meetings as of this pass: every meeting the list names that
 * has been read, each as last read, and read again if the list says it changed
 * and this pass has the requests for it. One pass at a time, and the one in
 * memory (a few minutes old) is reused.
 */
export function readMeetings(ctx: Context, key: string, congress: number): Promise<Meeting[]> {
  const now = Date.now()
  if (lastPass && now - lastPass.at < (lastPass.ok ? PASS_MS : FAILED_MS)) return lastPass.result
  const pass: NonNullable<typeof lastPass> = { at: now, ok: true, result: undefined as never }
  pass.result = runPass(ctx, key, congress).then(
    meetings => { pass.at = Date.now(); return meetings },
    err => { pass.ok = false; pass.at = Date.now(); throw err },
  )
  // A failure is rethrown to every caller, and an unhandled one is the caller's to catch.
  pass.result.catch(() => {})
  lastPass = pass
  return pass.result
}

async function runPass(ctx: Context, key: string, congress: number): Promise<Meeting[]> {
  const listed = await readList(ctx, key, congress)
  const [committed, staged, earlier] = await Promise.all([
    keptUnder(ctx, COMMITTED(congress), congress), keptUnder(ctx, STAGED(congress), congress), failingMeetings(ctx, congress),
  ])
  const current = new Map(listed.map(l => [l.eventId, l]))
  // A meeting is up to date when what is kept for it was read at the update time the list gives now.
  const upToDate = (l: ListedMeeting) => committed.kept.get(l.eventId)?.seen === l.updateDate || staged.kept.get(l.eventId)?.seen === l.updateDate
  const order = readOrder(Date.parse(`${ctx.today}T12:00:00Z`), listed, committed.kept, upToDate).slice(0, DETAILS_PER_PASS)

  // Read, keeping what is read as it goes, so a failure loses none of it.
  const read = new Map<string, Kept>()
  // The meetings whose answer came back and can't be read, each with the passes in a row it has failed on now.
  const failed = new Map<string, { error: string; strikes: number }>()
  let unsaved: Record<string, string> = {}
  const save = async () => {
    if (Object.keys(unsaved).length === 0) return
    const entries = unsaved
    unsaved = {}
    await ctx.cache.put(entries)
  }
  // Count this pass's failures, and alert once on each meeting they quarantine. Before an answer that
  // isn't 200 is rethrown too, since the meetings read before it were read.
  const settle = async () => {
    await save()
    if (failed.size === 0) return
    const quarantining = [...failed].filter(([id, f]) => f.strikes >= QUARANTINE_AFTER && !earlier.failing.get(id)?.alerted)
    // Alerted before it's kept as alerted: two alerts are better than none.
    if (quarantining.length > 0) await alertQuarantined(ctx, congress, quarantining)
    await ctx.cache.put(Object.fromEntries([...failed].map(([id, f]) => [
      `${FAILING(congress)}${id}`,
      JSON.stringify({ strikes: f.strikes, alerted: f.strikes >= QUARANTINE_AFTER || (earlier.failing.get(id)?.alerted ?? false) } satisfies Failing),
    ])))
  }
  try {
    for (const l of order) {
      const text = await get(detailUrl(congress, l), key,
        () => ctx.logCall('govinfo:CongressMeeting', { congress, chamber: l.chamber, eventId: l.eventId }), `Congress.gov meeting ${l.eventId}`)
      let meeting: Meeting
      try {
        meeting = parseMeeting(text, l, congress)
      } catch (err) {
        // Counted, and the pass reads on, so every meeting that fails is counted on this pass, and what it reads of the rest is kept.
        failed.set(l.eventId, { error: err instanceof Error ? err.message : String(err), strikes: (earlier.failing.get(l.eventId)?.strikes ?? 0) + 1 })
        continue
      }
      const kept: Kept = { seen: l.updateDate, meeting }
      read.set(l.eventId, kept)
      unsaved[`${STAGED(congress)}${l.eventId}`] = keep(kept)
      if (Object.keys(unsaved).length >= 10) await save()
    }
  } catch (err) {
    await settle()
    throw err
  }
  await settle()
  // A meeting short of its quarantine fails the pass closed, as before: nothing it read is shown yet.
  const holding = [...failed.values()].filter(f => f.strikes < QUARANTINE_AFTER)
  if (holding.length > 0) throw new Error(holding.map(f => f.error).join('; '))
  // Quarantined: failed on QUARANTINE_AFTER passes in a row, this one or (not read on this one) before.
  const quarantined = new Set(listed.map(l => l.eventId).filter(id => (failed.get(id)?.strikes ?? earlier.failing.get(id)?.strikes ?? 0) >= QUARANTINE_AFTER))

  // The pass finished: what it read, and what an earlier pass read and staged, is what is shown.
  const promote: Record<string, string> = {}
  for (const l of listed) {
    const fresh = read.get(l.eventId) ?? (staged.kept.get(l.eventId)?.seen === l.updateDate ? staged.kept.get(l.eventId) : undefined)
    if (fresh) {
      committed.kept.set(l.eventId, fresh)
      promote[`${COMMITTED(congress)}${l.eventId}`] = keep(fresh)
    }
  }
  await ctx.cache.put(promote)
  // An unreadable kept entry this pass didn't read again is lost; one it did read again was just replaced.
  const lost = committed.unreadable.filter(k => !(k in promote))
  // The first full read is done once every listed meeting has a kept copy, however old, or is quarantined, which the operators
  // were told of: a meeting that may never be read can't hold every bill's calendar back. An empty list proves nothing.
  const complete = listed.length > 0 && listed.every(l => committed.kept.has(l.eventId) || quarantined.has(l.eventId))
  if (complete && !(await isWarm(ctx, congress))) await ctx.cache.put({ [WARM(congress)]: new Date().toISOString() })
  // A listed meeting whose kept copy was lost has to be read again before a bill's calendar can say it has none.
  const cold = lost.some(k => current.has(k.slice(COMMITTED(congress).length)))
  // A meeting stops failing once it is read, or up to date some other way, or no longer listed: released, or forgotten.
  const recovered = [...earlier.failing.keys()].filter(id => !failed.has(id) && (read.has(id) || !current.has(id) || upToDate(current.get(id)!)))
  // Staged entries are done with, kept for a meeting the list no longer names or not; so are kept meetings it no longer names.
  await ctx.cache.drop([
    ...earlier.unreadable,
    ...recovered.map(id => `${FAILING(congress)}${id}`),
    ...staged.unreadable,
    ...[...staged.kept.keys()].map(id => `${STAGED(congress)}${id}`),
    ...[...read.keys()].map(id => `${STAGED(congress)}${id}`),
    ...lost,
    ...(cold ? [WARM(congress)] : []),
    ...[...committed.kept.keys()].filter(id => !current.has(id)).map(id => `${COMMITTED(congress)}${id}`),
  ])
  return listed.flatMap(l => {
    const k = committed.kept.get(l.eventId)
    return k ? [k.meeting] : []
  })
}

/** The one alert for the meetings a pass quarantined: each by its event id, with why it can't be read. */
async function alertQuarantined(ctx: Pick<ProviderContext, 'alert'>, congress: number, meetings: [id: string, f: { error: string }][]): Promise<void> {
  const ids = meetings.map(([id]) => id)
  await ctx.alert({
    subject: `committee meeting${ids.length > 1 ? 's' : ''} ${ids.join(', ')} quarantined`,
    text: [
      `The Congress.gov API's answer for ${ids.length > 1 ? 'these committee meetings' : 'this committee meeting'} of the ${ordinal(congress)} Congress `
        + `couldn't be read on ${QUARANTINE_AFTER} passes in a row, so the calendar now updates without ${ids.length > 1 ? 'them' : 'it'}:`,
      '',
      ...meetings.map(([, f]) => `- ${f.error}`),
      '',
      `What central already shows of ${ids.length > 1 ? 'them' : 'it'} (the body event, and each bill's entry) stays as it was. Every pass asks again, `
        + 'and a meeting is released the first time its answer can be read. No other alert follows for it.',
    ].join('\n'),
  })
}

// ---- What a calendar shows of a meeting

const BILL_LABEL: Record<CongressBillType, string> = {
  HR: 'H.R.', S: 'S.', HRES: 'H.Res.', SRES: 'S.Res.', HJRES: 'H.J.Res.', SJRES: 'S.J.Res.', HCONRES: 'H.Con.Res.', SCONRES: 'S.Con.Res.',
}

const CHAMBER_WORD: Record<MeetingChamber, string> = { house: 'House', senate: 'Senate', nochamber: 'Joint' }
const CHAMBER_CODE: Record<string, string> = { h: 'H', s: 'S', j: 'J' }

/** The committee a meeting is held under: the first the API names, with a name. */
function holder(m: Meeting): { systemCode: string; name: string } | null {
  const c = m.committees.find(x => x.name)
  return c ? { systemCode: c.systemCode, name: c.name! } : null
}

/** The system codes whose committees central needs ids for: the one each meeting is held under. */
export function holdingCommittees(meetings: readonly Meeting[]): string[] {
  return [...new Set(meetings.flatMap(m => holder(m)?.systemCode ?? []))]
}

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s)

/** A meeting's name for a calendar: its committee and type ("House Armed Services hearing"), which stays the same when its subject is retitled. */
function nameOf(m: Meeting): string {
  const h = holder(m)
  return `${h ? h.name : CHAMBER_WORD[m.chamber]} ${m.type.toLowerCase()}`
}

/** What a bill's calendar entry says of a meeting: its name, and its subject. */
function describe(m: Meeting): string {
  return m.title ? `${nameOf(m)}: ${cut(m.title, 280)}` : nameOf(m)
}

/** Changes whenever anything a calendar shows of the meeting changes. */
async function hashOf(m: Meeting): Promise<string> {
  const json = JSON.stringify([m.date, m.time, m.type, isCancelled(m.status), m.title, m.location, m.committees, m.bills])
  return (await sha256Hex(json)).slice(0, 32)
}

/** The meeting as a body event. `committeeId` is central's id for the committee the meeting is held under. */
export async function meetingBodyEvent(m: Meeting, committeeId: (systemCode: string) => number | undefined): Promise<BodyEvent> {
  const h = holder(m)
  const id = h ? committeeId(h.systemCode) : undefined
  const others = m.committees.filter(c => c.name && c.systemCode !== h?.systemCode).map(c => c.name!)
  const url = m.chamber === 'nochamber' ? null : `https://www.congress.gov/event/${ordinal(m.congress)}-Congress/${m.chamber}-event/${m.eventId}`
  return {
    event_id: m.eventId,
    kind: meetingType(m.type).kind,
    type: m.type,
    date: m.date,
    time: m.time,
    timezone: 'America/New_York',
    committee: h && id ? { committee_id: id, name: h.name, chamber: CHAMBER_CODE[h.systemCode[0]] ?? '' } : null,
    joint_with: others.length > 0 ? others.join(', ') : null,
    location: m.location,
    title: nameOf(m),
    agenda: [
      ...(m.title ? [{ topic: cut(m.title, 500), bill_number: null }] : []),
      ...m.bills.map(b => ({ topic: `${BILL_LABEL[b.type]} ${b.number}`, bill_number: legiscanNumber(b) })),
    ],
    url,
    event_hash: await hashOf(m),
    cancelled: isCancelled(m.status),
  }
}

/** The calendar entry a bill has for a meeting that takes it up. Its identity is the meeting's event id. */
export async function meetingEntry(m: Meeting): Promise<MeasureCalendarEntry> {
  const entry: MeasureCalendarEntry = {
    type_id: meetingType(m.type).typeId,
    type: m.type,
    date: m.date,
    time: m.time ?? '',
    location: m.location ?? '',
    description: describe(m),
    event_hash: await hashOf(m),
    event_id: m.eventId,
  }
  // Only a cancelled entry says so, so the entry of a live meeting is the same bytes it was before cancelling was a thing.
  if (isCancelled(m.status)) entry.cancelled = true
  return entry
}

/**
 * The entries each bill has, by the bill's key (`119/HR3132`): one for each
 * meeting that takes it up, past and cancelled ones too, by date. A bill
 * with none is left out.
 */
export async function entriesByBill(meetings: readonly Meeting[]): Promise<Map<string, MeasureCalendarEntry[]>> {
  const out = new Map<string, MeasureCalendarEntry[]>()
  for (const m of [...meetings].sort((a, b) => a.date.localeCompare(b.date) || Number(a.eventId) - Number(b.eventId))) {
    if (m.bills.length === 0) continue
    const entry = await meetingEntry(m)
    for (const b of m.bills) {
      const key = govinfoNativeKey(m.congress, b.type, b.number)
      out.set(key, [...(out.get(key) ?? []), entry])
    }
  }
  return out
}
