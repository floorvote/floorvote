import { GOVINFO_TYPES, readBillStatusZip } from './client'
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
 * What a bill carries so far is what a full read learns: its number, titles,
 * status, and latest action. Changed-only passes, a bill's sponsors, history,
 * and texts, roll call votes, and committee meetings come in later tickets
 * under #612.
 */
export const govinfo: Provider = {
  id: 'govinfo',
  displayName: 'GovInfo Bill Status',
  // Public domain data asks for no credit, so this names the sources as the
  // spec words them, and never says FloorVote publishes official data.
  attribution: {
    name: 'GovInfo Bill Status (GPO and Library of Congress), public domain; roll calls from the House Clerk and the Senate',
    url: 'https://www.govinfo.gov/bulkdata/BILLSTATUS',
    note: 'Bill data from GovInfo Bill Status (GPO and Library of Congress), public domain; roll calls from the House Clerk and the Senate.',
  },
  coverage: { maintainers: ['wtadler'] },
  envKeys: [],
  states: [GOVINFO_STATE],

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
    for (const type of GOVINFO_TYPES) {
      const expected = { congress, type: type.toUpperCase() as CongressBillType }
      await readBillStatusZip(congress, type, async (name, xml, modified) => {
        const { record, hash } = await parseBillFile(name, xml, expected, modified)
        const key = govinfoNativeKey(congress, record.type, record.number)
        if (keys.has(key)) throw new Error(`${name} repeats ${key}`)
        keys.add(key)
        found.push({ key, record, hash })
      }, () => ctx.logCall('govinfo:BillStatusZip', { congress, type }))
    }
    const ids = await ctx.ids('bill', found.map(f => f.key))
    const records = found.map((f): ProviderRecord => ({ billId: ids.get(f.key)!, nativeKey: f.key, raw: f.record, hash: f.hash }))
    return { records }
  },

  async toEntry(record) {
    return toGovInfoEntry(record.raw as GovInfoRecord, record.billId, record.hash)
  },

  async fetchMeasure({ billId, sessionId, nativeKey, record, session }) {
    if (!record || !nativeKey || sessionId === null) throw new Error(`bill ${billId} has no stored GovInfo record; the GovInfo sync has not seen it`)
    const r = record.raw as GovInfoRecord
    return buildGovInfoMeasure(r, billId, record.hash, {
      session_id: sessionId,
      session_name: session?.sessionName ?? congressName(r.congress),
      year_start: session?.yearStart ?? 2 * r.congress + 1787,
      year_end: session?.yearEnd ?? 2 * r.congress + 1788,
    })
  },

  vocabulary,
}
