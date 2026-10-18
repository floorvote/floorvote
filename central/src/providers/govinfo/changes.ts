import { sha256Hex, type MeasureCalendarEntry, type ProviderContext } from '../sdk'
import { GOVINFO_TYPES, type GovInfoType } from './client'

/**
 * What a GovInfo bill sync hands itself for the next pass, through the
 * snapshot ETag core stores once a pass finishes (#616): a watermark, and what
 * it needs to know whether a pass between full reads can stand in for one.
 *
 * A full read (the eight zips) answers a null ETag, the first pass of each UTC
 * day, and any mark that doesn't fit the pass. Between them a pass reads the
 * eight bulk listings and downloads only the files changed since the
 * watermark, less OVERLAP_MS: the listings give times to the minute, and a
 * file read twice is harmless, since an unchanged hash queues nothing.
 *
 * A bill's record also carries the calendar entries of the meetings that take
 * it up (meetings.ts), which change without its file. So with meetings on the
 * records, the mark names a digest of each bill's entries, as the pass that
 * made the mark put them on records, kept in the provider's cache under
 * `snapshot/<congress>/<id>`. The next pass compares it with the entries as
 * they are now, and downloads the file of every bill whose entries differ, as
 * though its file had changed. A digest that is gone or doesn't read is a read
 * in full, so a bill's record never keeps entries it no longer has.
 */
export interface Mark {
  congress: number
  /** The watermark: the newest change the pass saw (ISO). A full read's is the build time of its oldest zip. */
  since: string
  /** The UTC day of the last full read. A pass on another day reads in full. */
  full: string
  /** The types whose files the last full read read, from their zips. A type it found no zip for has files no pass has read. */
  types: GovInfoType[]
  /** The digest of the meeting entries the pass put on records, or null when it put none on (no key, or not warm). */
  meetings: string | null
}

/** How far back of the watermark a pass between full reads looks, for listing times written to the minute and a clock a little off. */
export const OVERLAP_MS = 6 * 60 * 60 * 1000
/** A watermark later than now by more than this came from a clock gone wrong, and is a read in full. */
const AHEAD_MS = 60 * 60 * 1000

const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/
const DAY = /^\d{4}-\d{2}-\d{2}$/
const DIGEST_ID = /^[0-9a-f]{16}$/

export function writeMark(mark: Mark): string {
  return JSON.stringify({ v: 1, ...mark })
}

/** The mark an ETag holds, or null when it holds none this Congress can use: a read in full. */
export function readMark(etag: string | null, congress: number): Mark | null {
  if (!etag) return null
  let m: unknown
  try {
    m = JSON.parse(etag)
  } catch {
    return null
  }
  if (typeof m !== 'object' || m === null) return null
  const r = m as Record<string, unknown>
  if (r.v !== 1 || r.congress !== congress) return null
  if (typeof r.since !== 'string' || !ISO_TIME.test(r.since) || Number.isNaN(Date.parse(r.since))) return null
  if (typeof r.full !== 'string' || !DAY.test(r.full)) return null
  if (!Array.isArray(r.types) || !r.types.every(t => (GOVINFO_TYPES as readonly unknown[]).includes(t))) return null
  if (r.meetings !== null && (typeof r.meetings !== 'string' || !DIGEST_ID.test(r.meetings))) return null
  return { congress, since: r.since, full: r.full, types: r.types as GovInfoType[], meetings: r.meetings as string | null }
}

/** Whether a mark can stand in for a full read today: read on this UTC day, not ahead of the clock, and with meetings on records exactly when they go on now. */
export function markHolds(mark: Mark, today: string, nowMs: number, meetingsOn: boolean): boolean {
  return mark.full === today && Date.parse(mark.since) <= nowMs + AHEAD_MS && (mark.meetings !== null) === meetingsOn
}

/** The later of two ISO times. */
export function laterOf(a: string, b: string): string {
  return Date.parse(b) > Date.parse(a) ? b : a
}

// ---- The digest of the meeting entries on records

/** Each bill's entries as a short hash, by bill key. A bill with none is left out, as it is from `entriesByBill`. */
export type Digest = Map<string, string>

export async function digestOf(byBill: ReadonlyMap<string, MeasureCalendarEntry[]>): Promise<Digest> {
  const out: Digest = new Map()
  for (const [key, entries] of byBill) out.set(key, (await sha256Hex(JSON.stringify(entries))).slice(0, 16))
  return out
}

const PREFIX = 'snapshot/'
const keyOf = (congress: number, id: string) => `${PREFIX}${congress}/${id}`

function serialize(digest: Digest): string {
  return JSON.stringify([...digest].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
}

/** The digest a mark names, or null when it is gone or isn't the digest its id says. */
export async function loadDigest(ctx: Pick<ProviderContext, 'cache'>, congress: number, id: string): Promise<Digest | null> {
  const value = (await ctx.cache.list(keyOf(congress, id))).get(keyOf(congress, id))
  if (value === undefined) return null
  if ((await sha256Hex(value)).slice(0, 16) !== id) return null
  try {
    const pairs = JSON.parse(value) as unknown
    if (!Array.isArray(pairs) || !pairs.every(p => Array.isArray(p) && p.length === 2 && typeof p[0] === 'string' && typeof p[1] === 'string')) return null
    return new Map(pairs as [string, string][])
  } catch {
    return null
  }
}

/**
 * Keep this pass's digest, and return its id for the mark. Every other digest
 * is dropped but the one the pass's own mark named, which the stored ETag
 * still names until core stores the new one, so a pass that fails leaves the
 * next one what it needs.
 */
export async function keepDigest(ctx: Pick<ProviderContext, 'cache'>, congress: number, digest: Digest | null, previous: Mark | null): Promise<string | null> {
  let id: string | null = null
  const keep = new Set<string>()
  if (previous?.meetings) keep.add(keyOf(previous.congress, previous.meetings))
  if (digest) {
    const value = serialize(digest)
    id = (await sha256Hex(value)).slice(0, 16)
    keep.add(keyOf(congress, id))
    await ctx.cache.put({ [keyOf(congress, id)]: value })
  }
  const stale = [...(await ctx.cache.list(PREFIX)).keys()].filter(k => !keep.has(k))
  if (stale.length > 0) await ctx.cache.drop(stale)
  return id
}
