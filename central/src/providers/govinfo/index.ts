import { fetchBillStatusFile, GOVINFO_TYPES, readBillStatusZip, type GovInfoType } from './client'
import { loadRollCalls, resolveVotes, voteKeys } from './votes'
import { detailKeys, readBillDetail, resolveDetail } from './detail'
import {
  buildGovInfoMeasure, congressName, congressOn, govinfoNativeKey, GOVINFO_STATE, parseBillFile, toGovInfoEntry, US_STATE_ID,
  type CongressBillType, type GovInfoRecord,
} from './map'
import { vocabulary } from './vocabulary'
import type { Provider, ProviderRecord, SyncSession } from '../sdk'

/**
 * Congress from GovInfo's Bill Status bulk data (client.ts, map.ts): one zip of
 * XML files per bill type, public domain, with no key. A snapshot provider for
 * the one state `US`, off until an operator claims `US` for it, and the data
 * of a deployment that doesn't claim it stays on LegiScan.
 *
 * Every snapshot is a full read: the eight zips for the current Congress,
 * streamed one file at a time and never a zip whole in memory, each file
 * reduced to a compact record (map.ts, `GovInfoRecord`) with a hash that
 * ignores the dates GovInfo restamps. Ids come from central's id table.
 *
 * A full read gives a bill its number, titles, status, and latest action. A
 * tracked bill's ingest downloads its own file again for the rest: history,
 * sponsors, texts, committees, subjects, related bills, and extras (detail.ts),
 * and then the roll calls its actions link, from the House Clerk's and the
 * Senate's own files, with every member's vote (votes.ts). Changed-only
 * passes and committee meetings come in later tickets under #612.
 */
export const govinfo: Provider = {
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
  envKeys: [],
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
    const found: { key: string; record: GovInfoRecord; hash: string }[] = []
    const keys = new Set<string>()
    // One zip at a time, each read to its end before the next is asked for. A failure in any
    // of the eight throws before an id is minted, so a bad pass writes nothing.
    let published = 0
    for (const type of GOVINFO_TYPES) {
      const expected = { congress, type: type.toUpperCase() as CongressBillType }
      const { found: zipExists } = await readBillStatusZip(congress, type, async (name, xml, modified) => {
        const { record, hash } = await parseBillFile(name, xml, expected, modified)
        const key = govinfoNativeKey(congress, record.type, record.number)
        if (keys.has(key)) throw new Error(`${name} repeats ${key}`)
        keys.add(key)
        found.push({ key, record, hash })
      }, () => ctx.logCall('govinfo:BillStatusZip', { congress, type }))
      if (zipExists) published++
    }
    // A type with no zip yet has no bills yet. All eight missing can't be told from a changed address.
    if (published === 0) throw new Error(`GovInfo ${congress}: none of the eight Bill Status zips exists (404)`)
    const ids = await ctx.ids('bill', found.map(f => f.key))
    const records = found.map((f): ProviderRecord => ({ billId: ids.get(f.key)!, nativeKey: f.key, raw: f.record, hash: f.hash }))
    return { records }
  },

  async toEntry(record) {
    return toGovInfoEntry(record.raw as GovInfoRecord, record.billId, record.hash)
  },

  /**
   * A tracked bill's full record: its bill-level fields from the compact record
   * the full read stored, and the rest from its own file, downloaded again.
   * The file is read and checked whole before any id is minted, so a file that
   * can't be read writes nothing and the ingest is retried. So does a roll
   * call it links that can't be read, and any Senate member the files can't
   * name (votes.ts). Committee meetings come in a later ticket under #612, from
   * the Congress.gov API.
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
    return buildGovInfoMeasure(r, billId, record.hash, {
      session_id: sessionId,
      session_name: session?.sessionName ?? congressName(r.congress),
      year_start: session?.yearStart ?? 2 * r.congress + 1787,
      year_end: session?.yearEnd ?? 2 * r.congress + 1788,
    }, { ...(await resolveDetail(detail, ids)), ...resolveVotes(nativeKey, rolls, ids) })
  },

  vocabulary,
}
