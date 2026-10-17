import { rateLimitedFetch } from '../sdk'
import { parseHistoricalMembers, parseHouseRollCall, parseSenateMembers, parseSenateRollCall, type RecordedVote, type RollCall } from './rollcalls'
import { readZip } from './zip'

/**
 * Client for GovInfo's Bill Status bulk data: one zip of XML files per bill
 * type per Congress, public domain, with no key.
 * https://www.govinfo.gov/bulkdata/BILLSTATUS
 *
 * A zip holds a file for each bill of its type, `BILLSTATUS-119hr3132.xml`,
 * deflated, with a data descriptor after each. The 119th Congress's eight zips
 * are 54 MB (33 MB of them House bills), and unpack to 248 MB of XML in 19,690
 * files, so a zip is always read as a stream, one file at a time.
 */
export const GOVINFO_BASE = 'https://www.govinfo.gov'

/** Congress's bill types as GovInfo names them in its paths, in the order a full read takes them. */
export const GOVINFO_TYPES = ['hr', 's', 'hres', 'sres', 'hjres', 'sjres', 'hconres', 'sconres'] as const
export type GovInfoType = typeof GOVINFO_TYPES[number]

/** Eight downloads a pass, paced as a courtesy: GovInfo documents no limit for its bulk data. */
const GOVINFO_RATE_PER_SEC = 2

export function billStatusZipUrl(congress: number, type: GovInfoType): string {
  return `${GOVINFO_BASE}/bulkdata/BILLSTATUS/${congress}/${type}/BILLSTATUS-${congress}-${type}.zip`
}

/** One bill's Bill Status file, by its own address: `.../119/hr/BILLSTATUS-119hr3132.xml`. */
export function billStatusFileUrl(congress: number, type: GovInfoType, number: string): string {
  return `${GOVINFO_BASE}/bulkdata/BILLSTATUS/${congress}/${type}/BILLSTATUS-${congress}${type}${number}.xml`
}

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false })

/** An HTTP date as an ISO time (`2026-10-17T00:19:30Z`), or null when there is none or it isn't one. */
function httpDate(value: string | null): string | null {
  if (!value) return null
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? null : new Date(ms).toISOString().replace('.000Z', 'Z')
}

/**
 * Read one zip, handing each file's text to `onFile` as it is unpacked, with
 * the time GovInfo says it built the zip. Resolves with whether the zip
 * exists, and how many files it held.
 *
 * A 404 is a zip GovInfo hasn't published yet, such as a type with no bills at
 * the start of a Congress: `found` is false and no file is handed over. The
 * caller decides what that means, since all eight missing can't be told from
 * a changed address.
 *
 * Every other failure throws an error that names the zip: a download that
 * isn't a complete zip (an HTTP error, a web page, a body cut off), a file
 * that isn't UTF-8, and anything `onFile` throws for a file it can't read.
 */
export async function readBillStatusZip(
  congress: number,
  type: GovInfoType,
  onFile: (name: string, xml: string, modified: string | null) => void | Promise<void>,
  onRequest?: () => void,
): Promise<{ found: boolean; entries: number }> {
  const url = billStatusZipUrl(congress, type)
  try {
    const res = await rateLimitedFetch(url, { headers: { Accept: 'application/zip' } },
      { ratePerSec: GOVINFO_RATE_PER_SEC, bucketKey: 'govinfo', onRequest })
    if (res.status === 404) {
      await res.body?.cancel().catch(() => {})
      return { found: false, entries: 0 }
    }
    const modified = httpDate(res.headers.get('Last-Modified'))
    const { entries } = await readZip(res, (name, data) => onFile(name, utf8.decode(data), modified))
    return { found: true, entries }
  } catch (err) {
    throw new Error(`GovInfo ${congress}/${type}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/**
 * One bill's own Bill Status file, as text, for the ingest of a tracked bill:
 * the full read keeps only a compact record, so the detail (history, sponsors,
 * texts, and the rest) comes from downloading the file again. One file is at
 * most a few megabytes (the largest in the 119th Congress is 2.5 MB), so it is
 * read whole.
 *
 * Every answer but a 200 throws, a 404 too: a bill the full read listed has a
 * file, so a missing one is GovInfo changing something, and the ingest is
 * retried. So does a body that isn't UTF-8 text. What the text holds is the
 * caller's to check.
 */
export async function fetchBillStatusFile(
  congress: number,
  type: GovInfoType,
  number: string,
  onRequest?: () => void,
): Promise<string> {
  const url = billStatusFileUrl(congress, type, number)
  try {
    const res = await rateLimitedFetch(url, { headers: { Accept: 'application/xml' } },
      { ratePerSec: GOVINFO_RATE_PER_SEC, bucketKey: 'govinfo', onRequest })
    if (res.status !== 200) {
      await res.body?.cancel().catch(() => {})
      throw new Error(`HTTP ${res.status}`)
    }
    return utf8.decode(await res.arrayBuffer())
  } catch (err) {
    throw new Error(`GovInfo ${congress}/${type}/${number}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

// ---- Roll calls and the files that name their senators (#618)

/** Where the roll call files and the member files are, as the House Clerk, the Senate, and congress-legislators publish them. */
export const SENATE_MEMBERS_URL = 'https://www.senate.gov/legislative/LIS_MEMBER/cvc_member_data.xml'
export const HISTORICAL_MEMBERS_URL = 'https://unitedstates.github.io/congress-legislators/legislators-historical.csv'

/** A request or two for each roll call, paced as a courtesy to each host: none of the three documents a limit. */
const ROLL_CALL_RATE_PER_SEC = 2

/**
 * What a read file is kept as, and for how long. A bill's ingest reads the roll
 * calls its actions link, and the bills of one run share them: a House vote on a
 * package of bills is the same file in each, and the member list and the
 * historical file are the same for every Senate vote. So each file is read once
 * and kept, as what it was read into (a roll call as its votes, not its text),
 * for the next bill's ingest. Nothing is kept past ten minutes, so a roll call
 * the Senate corrects is read again by a later run, nothing is kept for good in
 * a Worker that lives for days, and a failed answer is never kept.
 */
const KEEP_MS = 10 * 60 * 1000
/**
 * A roll call is kept as a plain copy of its votes (below), a few dozen KB for a
 * House roll call of 435 members, so this holds a few MB at most. Without the copy
 * each string would be a slice of the file's text, and a kept roll call would hold
 * the whole file (the same reason map.ts copies a bill's record).
 */
const KEEP_ROLL_CALLS = 128

interface Kept<T> { at: number; value: T }
const rollCalls = new Map<string, Kept<RollCall>>()
let senateMembers: Kept<Map<string, string>> | null = null
let historicalMembers: Kept<Map<string, string>> | null = null

/** Forget every roll call and member file read so far. For tests: a real ingest lets them expire. */
export function clearRollCallCaches(): void {
  rollCalls.clear()
  senateMembers = null
  historicalMembers = null
}

const fresh = <T>(k: Kept<T> | null | undefined): k is Kept<T> => !!k && Date.now() - k.at < KEEP_MS

/** The body of a 200 answer as UTF-8 text. Any other answer, and a body that isn't text, throws an error that names the file. */
async function fetchText(url: string, accept: string, bucketKey: string, what: string, onRequest?: () => void): Promise<string> {
  try {
    // A redirect isn't followed: an answer of 30x is no 200, so one off the host that was asked fails closed.
    const res = await rateLimitedFetch(url, { headers: { Accept: accept }, redirect: 'manual' },
      { ratePerSec: ROLL_CALL_RATE_PER_SEC, bucketKey, onRequest })
    if (res.status !== 200) {
      await res.body?.cancel().catch(() => {})
      throw new Error(`HTTP ${res.status}`)
    }
    return utf8.decode(await res.arrayBuffer())
  } catch (err) {
    throw new Error(`${what}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/**
 * One roll call, read from the House Clerk's or the Senate's own file at the
 * address its bill linked (readRecordedVotes checked that the address is theirs
 * and is for this vote). Fails closed: anything but a 200, text that isn't
 * UTF-8, XML that isn't that file shape, and a file for another vote throw.
 */
export async function fetchRollCall(vote: RecordedVote, onRequest?: () => void): Promise<RollCall> {
  const kept = rollCalls.get(vote.url)
  if (fresh(kept)) {
    // Used last: a roll call that keeps being asked for isn't the one to let go.
    rollCalls.delete(vote.url)
    rollCalls.set(vote.url, kept)
    return kept.value
  }
  const house = vote.chamber === 'H'
  const name = `${house ? 'House' : 'Senate'} roll call ${vote.url}`
  const xml = await fetchText(vote.url, 'application/xml', house ? 'house-clerk' : 'senate-gov', `GovInfo ${name}`, onRequest)
  const rollCall = JSON.parse(JSON.stringify((house ? parseHouseRollCall : parseSenateRollCall)(name, xml, vote))) as RollCall
  rollCalls.delete(vote.url)
  rollCalls.set(vote.url, { at: Date.now(), value: rollCall })
  while (rollCalls.size > KEEP_ROLL_CALLS) rollCalls.delete(rollCalls.keys().next().value!)
  return rollCall
}

/** senate.gov's member list: LIS id to Bioguide id, for the senators now sitting. */
async function fetchSenateMembers(onRequest?: () => void): Promise<Map<string, string>> {
  if (fresh(senateMembers)) return senateMembers.value
  const value = parseSenateMembers(await fetchText(SENATE_MEMBERS_URL, 'application/xml', 'senate-gov', 'GovInfo senate.gov\'s member list', onRequest))
  senateMembers = { at: Date.now(), value }
  return value
}

/** congress-legislators' historical file: LIS id to Bioguide id, for the senators who have left. */
async function fetchHistoricalMembers(onRequest?: () => void): Promise<Map<string, string>> {
  if (fresh(historicalMembers)) return historicalMembers.value
  const value = parseHistoricalMembers(await fetchText(HISTORICAL_MEMBERS_URL, 'text/csv', 'congress-legislators', 'GovInfo congress-legislators\' historical file', onRequest))
  historicalMembers = { at: Date.now(), value }
  return value
}

/**
 * The Bioguide id of each of these Senate LIS ids: senate.gov's member list
 * for the sitting senators, and the historical file, read only when the list
 * lacks one of them (a senator who left during the Congress), and at most
 * once for every ingest that shares it. An id neither knows fails closed, with
 * an error that names every such id.
 */
export async function bioguideIdsOfSenators(
  lisIds: Iterable<string>,
  onRequest: { members: () => void; historical: () => void },
): Promise<Map<string, string>> {
  const wanted = [...new Set(lisIds)]
  const out = new Map<string, string>()
  if (wanted.length === 0) return out
  const sitting = await fetchSenateMembers(onRequest.members)
  let missing: string[] = []
  for (const id of wanted) {
    const bioguide = sitting.get(id)
    if (bioguide) out.set(id, bioguide)
    else missing.push(id)
  }
  if (missing.length > 0) {
    const gone = await fetchHistoricalMembers(onRequest.historical)
    const still: string[] = []
    for (const id of missing) {
      const bioguide = gone.get(id)
      if (bioguide) out.set(id, bioguide)
      else still.push(id)
    }
    missing = still
  }
  if (missing.length > 0) {
    throw new Error(`GovInfo roll call: no Bioguide id for Senate member id${missing.length > 1 ? 's' : ''} ${missing.sort().join(', ')}, in senate.gov's member list or congress-legislators' historical file`)
  }
  return out
}
