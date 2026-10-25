import { fetchBillStatusFile, GOVINFO_TYPES, readBillStatusListing, readBillStatusZip, type GovInfoType, type ListedBillFile } from './client'
import { digestOf, keepDigest, laterOf, loadDigest, markHolds, mergeDigest, OVERLAP_MS, readMark, writeMark, type Digest, type Mark } from './changes'
import { loadRollCalls, resolveVotes, voteKeys } from './votes'
import { detailKeys, readBillDetail, resolveDetail } from './detail'
import {
  buildGovInfoMeasure, congressName, congressOn, govinfoNativeKey, GOVINFO_STATE, parseBillFile, toGovInfoEntry, US_STATE_ID,
  type CongressBillType, type GovInfoRecord,
} from './map'
import { entriesByBill, holdingCommittees, isWarm, keptMeetings, meetingBodyEvent, readMeetings } from './meetings'
import { vocabulary } from './vocabulary'
import { sha256Hex, type MeasureCalendarEntry, type Provider, type ProviderContext, type ProviderRecord, type ProviderSnapshot, type SyncSession } from '../sdk'

/**
 * Congress from GovInfo's Bill Status bulk data (client.ts, map.ts): one zip of
 * XML files per bill type, public domain, with no key. A snapshot provider for
 * the one state `US`, off until an operator claims `US` for it, and the data
 * of a deployment that doesn't claim it stays on LegiScan.
 *
 * A full read takes the eight zips for the current Congress, streamed one file
 * at a time and never a zip whole in memory, each file reduced to a compact
 * record (map.ts, `GovInfoRecord`) with a hash that ignores the dates GovInfo
 * restamps. Ids come from central's id table. A full read answers a null ETag
 * (the first pass, a claim, a forced run) and the first pass of each UTC day.
 * Between them a pass reads the eight bulk listings and downloads only the
 * files changed since the last pass's watermark, and returns a partial
 * snapshot of them (changes.ts).
 *
 * A full read gives a bill its number, titles, status, and latest action. A
 * tracked bill's ingest downloads its own file again for the rest: history,
 * sponsors, texts, committees, subjects, related bills, and extras (detail.ts),
 * and then the roll calls its actions link, from the House Clerk's and the
 * Senate's own files, with every member's vote (votes.ts).
 *
 * With an optional Congress.gov key (`CONGRESS_API_KEY`), the committee
 * meetings of the Congress too (meetings.ts): `listBodyEvents` serves them as
 * body events, and each bill's record carries the calendar entry of every
 * meeting that takes it up, so the bill's calendar needs no request to the API
 * when it is ingested. Without the key none of it runs, and the calendars are
 * empty. A pass between full reads also downloads the file of each bill whose
 * meetings changed, so its record changes with them.
 */
export const govinfo: Provider<'CONGRESS_API_KEY'> = {
  id: 'govinfo',
  displayName: 'GovInfo Bill Status',
  // Public domain data asks for no credit, so this names the sources as the
  // spec words them, and never says FloorVote publishes official data. Footers
  // render only the name for an unlicensed credit, so the name carries the line.
  attribution: {
    name: 'GovInfo Bill Status (GPO and Library of Congress), public domain; roll calls from the House Clerk and the Senate',
    url: 'https://www.govinfo.gov/bulkdata/BILLSTATUS',
  },
  coverage: { maintainers: ['wtadler'] },
  envKeys: ['CONGRESS_API_KEY'],
  states: [GOVINFO_STATE],
  // A bill's measure carries every roll call its actions link, so one its file no longer links is dropped with its member votes.
  replacesRollCalls: true,

  /** One session: the Congress in session today. Core marks an earlier one prior and sine die once it is no longer listed. */
  async listSessions(_state, ctx) {
    const { congress, yearStart, yearEnd } = congressOn(ctx.today)
    const ids = await ctx.ids('session', [String(congress)])
    return [{
      session_id: ids.get(String(congress))!,
      session_name: congressName(congress),
      state_id: US_STATE_ID,
      year_start: yearStart,
      year_end: yearEnd,
      session_tag: String(congress),
      prior: 0,
      sine_die: 0,
      special: 0,
    } satisfies SyncSession]
  },

  // Only the current Congress syncs. LegiScan's earlier US sessions stay as they are.
  selectSessions(sessions) {
    return sessions.filter(s => !s.prior)
  },

  async snapshot(session, ctx) {
    const congress = Number(session.sessionTag)
    if (!Number.isInteger(congress) || congress < 1) throw new Error(`GovInfo session ${session.sessionId} names no Congress`)
    // With a key, a bill's record carries the calendar entries of the meetings that take it up, as the last
    // pass that finished left them (meetings.ts), so a bill whose meetings change is a bill whose record changed.
    // Only once every meeting has been read once (meetings.ts, isWarm): before that a bill with no meetings
    // may have one not read yet, so its record says nothing, and neither does its calendar. After it, a bill
    // with none has an empty list, which is a calendar with nothing on it.
    const byBill = ctx.env.CONGRESS_API_KEY && await isWarm(ctx, congress)
      ? await entriesByBill(await keptMeetings(ctx, congress))
      : null
    const mark = readMark(session.etag, congress)
    if (mark && markHolds(mark, ctx.today, Date.now(), byBill !== null)) {
      const listings = await readListings(congress, ctx)
      const changed = await readChanged(congress, mark, byBill, listings, ctx)
      if (changed) return changed
      return readInFull(session.sessionId, congress, mark, byBill, ctx, listings)
    }
    return readInFull(session.sessionId, congress, mark, byBill, ctx)
  },

  /**
   * The Congress's committee meetings in a month, from the Congress.gov API,
   * when a key is set (meetings.ts): each a body event under the API's own
   * event id, with its committee under the id a bill's own committee system
   * code gives it. Without a key the calendar is empty, and nothing is asked.
   * A failing API fails the month, and core leaves the calendar as it was.
   */
  async listBodyEvents(_state, range, ctx) {
    const key = ctx.env.CONGRESS_API_KEY
    if (!key) return []
    const { congress, yearStart } = congressOn(ctx.today)
    const inRange = (m: { date: string }) => range.from <= m.date && m.date <= range.to
    const meetings = (await readMeetings(ctx, key, congress)).filter(inRange)
    // The earlier Congress ends on January 3 and core still asks for last month, so a range that starts before the
    // new Congress does also holds the earlier one's meetings, as last kept. A meeting that was held is never cancelled
    // for the list that named it having changed. Nothing is asked of the API, and nothing of theirs is pruned.
    if (range.from < `${yearStart}-01-03`) meetings.push(...(await keptMeetings(ctx, congress - 1)).filter(inRange))
    const codes = holdingCommittees(meetings)
    const ids = codes.length > 0 ? await ctx.ids('committee', codes) : new Map<string, number>()
    return Promise.all(meetings.map(m => meetingBodyEvent(m, code => ids.get(code))))
  },

  /**
   * Before GovInfo owns `US`: read the Congress's meetings into the cache, as
   * `listBodyEvents` would, and show them nowhere, so the first read (a day or
   * two) is done, and `warm/<congress>` written, before the switch (#913).
   * Mints no committee id and lists no session. A meeting quarantined meanwhile
   * still emails the operators once. Without a key, asks nothing and says so.
   */
  async warmBodyEvents(_state, ctx) {
    const key = ctx.env.CONGRESS_API_KEY
    if (!key) return null
    const { congress } = congressOn(ctx.today)
    try {
      await readMeetings(ctx, key, congress)
    } catch (err) {
      // Named for the Congress, so the operators' alert says which cache isn't warming (#979).
      throw new Error(`the ${congressName(congress)}'s committee meetings: ${err instanceof Error ? err.message : String(err)}`, { cause: err })
    }
    return { warm: await isWarm(ctx, congress) }
  },

  async toEntry(record) {
    return toGovInfoEntry(record.raw as GovInfoRecord, record.billId, record.hash)
  },

  /** A member's person id is minted from their Bioguide id (detail.ts, votes.ts), so a cutover can match members no bill it reads names. */
  async personIdsForBioguide(bioguideIds, ctx) {
    const wanted = [...new Set(bioguideIds.filter(id => /^[A-Z]\d{6}$/.test(id)))]
    return wanted.length > 0 ? ctx.ids('person', wanted) : new Map<string, number>()
  },

  /**
   * A tracked bill's full record: its bill-level fields from the compact record
   * the full read stored, and the rest from its own file, downloaded again.
   * The file is read and checked whole before any id is minted, so a file that
   * can't be read writes nothing and the ingest is retried. So does a roll
   * call it links that can't be read, and any Senate member the files can't
   * name (votes.ts). With a Congress.gov key, the calendar is the record's
   * meetings, which the bill sync filled in from the meetings it had kept
   * (meetings.ts), so the ingest asks the API for nothing.
   */
  async fetchMeasure({ billId, sessionId, nativeKey, record, session }, ctx) {
    if (!record || !nativeKey || sessionId === null) throw new Error(`bill ${billId} has no stored GovInfo record; the GovInfo sync has not seen it`)
    const r = record.raw as GovInfoRecord
    const type = r.type.toLowerCase() as GovInfoType
    const xml = await fetchBillStatusFile(r.congress, type, r.number, () => ctx.logCall('govinfo:BillStatusFile', { congress: r.congress, type, number: r.number }))
    const detail = readBillDetail(`BILLSTATUS-${r.congress}${type}${r.number}.xml`, xml, r)
    // Every roll call is read before an id is minted, so a bad one mints nothing.
    const rolls = await loadRollCalls(detail.recordedVotes, {
      roll: vote => ctx.logCall(vote.chamber === 'H' ? 'govinfo:HouseRollCall' : 'govinfo:SenateRollCall', { congress: vote.congress, session: vote.session, roll: vote.roll }),
      members: () => ctx.logCall('govinfo:SenateMembers', {}),
      historical: () => ctx.logCall('govinfo:LegislatorsHistorical', {}),
    })
    const keys = detailKeys(detail)
    const voted = voteKeys(nativeKey, rolls)
    // One id table call a kind, in turn: each is a batch of its own.
    const ids = {
      person: await ctx.ids('person', [...new Set([...keys.person, ...voted.person])]),
      doc: await ctx.ids('doc', keys.doc),
      committee: await ctx.ids('committee', keys.committee),
      subject: await ctx.ids('subject', keys.subject),
      bill: await ctx.ids('bill', keys.bill),
      rollcall: await ctx.ids('rollcall', voted.rollcall),
    }
    const measure = buildGovInfoMeasure(r, billId, record.hash, {
      session_id: sessionId,
      session_name: session?.sessionName ?? congressName(r.congress),
      year_start: session?.yearStart ?? 2 * r.congress + 1787,
      year_end: session?.yearEnd ?? 2 * r.congress + 1788,
    }, { ...(await resolveDetail(detail, ids)), ...resolveVotes(nativeKey, rolls, ids) })
    // With a key, the calendar is the record's meetings, and none is a calendar with nothing on it. Without
    // one the measure has no calendar at all, which is no word on the entries a bill already has.
    if (ctx.env.CONGRESS_API_KEY && r.meetings !== undefined) measure.calendar = r.meetings
    return measure
  },

  vocabulary,
}

interface Found { key: string; record: GovInfoRecord; hash: string }

/** Put each bill's meeting entries on its record and in its hash, when meetings go on records at all. */
async function withMeetings(found: Found[], byBill: ReadonlyMap<string, MeasureCalendarEntry[]> | null): Promise<void> {
  if (!byBill) return
  for (const f of found) {
    const entries = byBill.get(f.key) ?? []
    f.record.meetings = entries
    f.hash = await sha256Hex(`${f.hash}\n${JSON.stringify(entries)}`)
  }
}

async function toRecords(found: Found[], ctx: ProviderContext): Promise<ProviderRecord[]> {
  const ids = await ctx.ids('bill', found.map(f => f.key))
  return found.map((f): ProviderRecord => ({ billId: ids.get(f.key)!, nativeKey: f.key, raw: f.record, hash: f.hash }))
}

/** One bill's own file, downloaded and checked to be the bill its listing says. */
async function readListedFile(congress: number, key: string, type: GovInfoType, file: ListedBillFile, ctx: ProviderContext): Promise<Found> {
  const xml = await fetchBillStatusFile(congress, type, file.number, () => ctx.logCall('govinfo:BillStatusFile', { congress, type, number: file.number }))
  const { record, hash } = await parseBillFile(file.name, xml, { congress, type: type.toUpperCase() as CongressBillType }, file.modified)
  const holds = govinfoNativeKey(congress, record.type, record.number)
  if (holds !== key) throw new Error(`GovInfo ${file.name}: it holds ${holds}, not ${key}`)
  return { key, record, hash }
}

type Listings = Awaited<ReturnType<typeof readListings>>

/** The eight listings, every one read before anything else is, by bill key, with the newest time they give. */
async function readListings(congress: number, ctx: ProviderContext) {
  const listed = new Map<string, { type: GovInfoType; file: ListedBillFile }>()
  const zipModified = new Map<GovInfoType, string | null>()
  let newest: string | null = null
  for (const type of GOVINFO_TYPES) {
    const listing = await readBillStatusListing(congress, type, () => ctx.logCall('govinfo:BillStatusListing', { congress, type }))
    zipModified.set(type, listing.zipModified)
    for (const file of listing.files) {
      listed.set(govinfoNativeKey(congress, type.toUpperCase(), file.number), { type, file })
      newest = newest === null ? file.modified : laterOf(newest, file.modified)
    }
  }
  return { listed, zipModified, newest }
}

/**
 * A full read: the eight listings, then every file of the eight zips, then the
 * file of each bill listed as changed since its type's zip was built (less the
 * overlap). A zip holds each file as it was when the zip was built, and GovInfo
 * can go days without rebuilding one, so without that a full read would put back
 * what a pass between full reads had already moved past, and the next pass would
 * move it forward again. A listed bill not yet in its zip is read the same way.
 * The watermark is the newest time the read saw, of a listed file or a zip. A
 * type whose zip has no build time, from its Last-Modified or its listing, can't
 * be told from its files, so the read leaves no ETag and the next pass reads in
 * full too.
 */
async function readInFull(
  sessionId: number, congress: number, previous: Mark | null, byBill: Map<string, MeasureCalendarEntry[]> | null, ctx: ProviderContext, listings?: Listings,
): Promise<ProviderSnapshot> {
  const { listed, zipModified, newest } = listings ?? await readListings(congress, ctx)
  const found = new Map<string, Found>()
  const types: GovInfoType[] = []
  const missing: GovInfoType[] = []
  const built = new Map<GovInfoType, string | null>()
  // One zip at a time, each read to its end before the next is asked for. A failure in any
  // of the eight throws before an id is minted, so a bad pass writes nothing.
  for (const type of GOVINFO_TYPES) {
    const expected = { congress, type: type.toUpperCase() as CongressBillType }
    const zip = await readBillStatusZip(congress, type, async (name, xml, modified) => {
      const { record, hash } = await parseBillFile(name, xml, expected, modified)
      const key = govinfoNativeKey(congress, record.type, record.number)
      if (found.has(key)) throw new Error(`${name} repeats ${key}`)
      found.set(key, { key, record, hash })
    }, () => ctx.logCall('govinfo:BillStatusZip', { congress, type }))
    if (!zip.found) {
      console.warn(`[sync-govinfo] Congress ${congress}: the ${type} Bill Status zip answered 404, so this read has no ${type} bills`)
      missing.push(type)
      continue
    }
    types.push(type)
    built.set(type, zip.modified ?? zipModified.get(type) ?? null)
  }
  // A type with no zip yet has no bills yet. All eight missing can't be told from a changed address.
  if (types.length === 0) throw new Error(`GovInfo ${congress}: none of the eight Bill Status zips exists (404)`)
  for (const [key, { type, file }] of listed) {
    const at = built.get(type)
    if (!at) continue
    if (Date.parse(file.modified) >= Date.parse(at) - OVERLAP_MS) found.set(key, await readListedFile(congress, key, type, file, ctx))
  }
  const all = [...found.values()]
  await withMeetings(all, byBill)
  const records = await toRecords(all, ctx)
  const meetings = await keepDigest(ctx, congress, byBill ? await digestOf(byBill) : null, previous)
  // Every bill is now as of the listings: from its zip when its zip is newer than its file, and from its own
  // file when not. So the watermark is the newest time the read saw, of a file or a zip.
  const dated = types.every(t => built.get(t))
  const since = types.map(t => built.get(t)!).reduce((a, b) => laterOf(a, b), newest ?? built.get(types[0])!)
  const etag = dated ? writeMark({ congress, since, full: ctx.today, types, meetings }) : null
  await alertVanished(congress, types, missing, sessionId, ctx)
  return { records, etag }
}

/**
 * A type whose zip was missing from a full read but has stored records for the
 * Congress was there before and has vanished, so its bills have stopped updating:
 * alert, and carry on, since the other types are fine. A type with none stored
 * has no bills yet. Only a full read says so: a pass between full reads
 * legitimately returns no records for most types.
 */
async function alertVanished(congress: number, answered: GovInfoType[], missing: GovInfoType[], sessionId: number, ctx: ProviderContext): Promise<void> {
  // The alert is a courtesy beside a pass that otherwise succeeded, so a failing cache or stored-record read is logged and never fails the pass.
  try {
    // One alert per outage: the cache holds a key for each type already alerted on, and drops it once the type's zip answers.
    const alerted = await ctx.cache.list(`alerted/${congress}/`)
    const keyOf = (type: GovInfoType) => `alerted/${congress}/${type}`
    const answeredAgain = answered.map(keyOf).filter(k => alerted.has(k))
    if (answeredAgain.length > 0) await ctx.cache.drop(answeredAgain)
    for (const type of missing) {
      if (alerted.has(keyOf(type))) continue
      if (!await ctx.hasStored(sessionId, `${congress}/${type.toUpperCase()}[0-9]*`)) continue
      await ctx.alert({
        subject: `the ${type} Bill Status zip for Congress ${congress} is gone`,
        text: `The ${type} Bill Status zip for Congress ${congress} answered 404, though central has stored ${type} bills for it. Those bills have stopped updating, and the other types kept syncing. Check GovInfo's bulk data for BILLSTATUS/${congress}/${type}. This is sent once for the outage, and again if the zip answers and then vanishes again.`,
      })
      // If this fails the alert was sent, and the next full read sends it again, which is the safe way to be wrong.
      await ctx.cache.put({ [keyOf(type)]: new Date().toISOString() }) // ts-write-ok: a marker value in provider_cache, never read as a time
    }
  } catch (err) {
    console.error(`[sync-govinfo] Congress ${congress}: the vanished-type check failed, and the pass carries on:`, err)
  }
}

/**
 * A pass between full reads: the eight listings, then each file listed as
 * changed since the watermark (less the overlap), and each file of a bill whose
 * meeting entries differ from those the last pass put on its record. Every
 * listing is read before any file, and any that fails throws, so the pass
 * writes nothing and the stored watermark stays for the next. Null when the
 * pass can't stand in for a full read after all: a type the last full read had
 * no zip for now lists files, or the digest of what is on records is gone.
 */
async function readChanged(
  congress: number, mark: Mark, byBill: Map<string, MeasureCalendarEntry[]> | null, { listed, newest }: Listings, ctx: ProviderContext,
): Promise<ProviderSnapshot | null> {
  const since = newest ? laterOf(mark.since, newest) : mark.since
  const unread = [...listed.values()].some(({ type }) => !mark.types.includes(type))
  if (unread) return null

  const from = Date.parse(mark.since) - OVERLAP_MS
  const want = new Map([...listed].filter(([, { file }]) => Date.parse(file.modified) >= from))
  let digest: Digest | null = null
  if (byBill) {
    const before = await loadDigest(ctx, congress, mark.meetings!)
    if (!before) return null
    const merged = mergeDigest(before, await digestOf(byBill), key => listed.has(key))
    for (const key of merged.changed) want.set(key, listed.get(key)!)
    digest = merged.digest
  }

  const found: Found[] = []
  for (const [key, { type, file }] of want) found.push(await readListedFile(congress, key, type, file, ctx))
  await withMeetings(found, byBill)
  const records = await toRecords(found, ctx)
  const meetings = await keepDigest(ctx, congress, digest, mark)
  return { records, partial: true, etag: writeMark({ ...mark, since, meetings }) }
}
