import { getMgaSession, mgaSessionExists, type MgaRecord } from './client'
import { buildMgaBill, MD_STATE_ID, MGA_STATE, mgaDocKeys, mgaNativeKey, mgaRecordHash, mgaSponsorNames, toMgaMasterListEntry } from './map'
import { vocabulary } from './vocabulary'
import type { Provider, ProviderRecord, SyncSession } from '../sdk'

/**
 * The Maryland General Assembly's open data (client.ts, map.ts): one JSON file
 * per session with every bill, so a pass is one request and a bill is built
 * from its stored record with no further calls. Ids come from central's id
 * table. The data needs no key, and its requests aren't logged as API calls.
 */
export const mga: Provider<'MGA_STATES'> = {
  id: 'mga',
  envKeys: ['MGA_STATES'],
  states: [MGA_STATE],
  enabled: env => (env.MGA_STATES ?? '').split(',').some(s => s.trim().toUpperCase() === MGA_STATE),

  /**
   * The sessions the MGA has published for this year and next: the regular
   * session and up to two special sessions this year (one HEAD request each),
   * and next year's regular session once its prefiles appear.
   */
  async listSessions(_state, ctx) {
    const year = Number(ctx.today.slice(0, 4))
    const codes: string[] = []
    for (const code of [`${year}RS`, `${year}S1`, `${year}S2`, `${year + 1}RS`]) {
      if (await mgaSessionExists(code)) codes.push(code)
    }
    const ids = await ctx.ids('session', codes)
    return codes.map((code): SyncSession => {
      const sessionYear = Number(code.slice(0, 4))
      return {
        session_id: ids.get(code)!,
        session_name: sessionName(code),
        state_id: MD_STATE_ID,
        year_start: sessionYear,
        year_end: sessionYear,
        special: /S\d+$/.test(code) ? 1 : 0,
        session_tag: code,
        prior: 0,
        sine_die: 0,
      }
    })
  },

  // This year's sessions keep syncing after sine die: the Governor signs and
  // vetoes into late May. Next year's regular session appears with its prefiles.
  selectSessions(sessions, today) {
    const year = Number(today.slice(0, 4))
    return sessions.filter(s => s.yearStart >= year)
  },

  async snapshot(session, ctx) {
    const code = session.sessionTag
    const rows = await getMgaSession(code)
    if (!rows) return { records: [] }
    const ids = await ctx.ids('bill', rows.map(r => mgaNativeKey(code, r.BillNumber)))
    const records = await Promise.all(rows.map(async (r): Promise<ProviderRecord> => ({
      billId: ids.get(mgaNativeKey(code, r.BillNumber))!,
      nativeKey: mgaNativeKey(code, r.BillNumber),
      raw: r,
      hash: await mgaRecordHash(r),
    })))
    return { records }
  },

  async toEntry(record, stored) {
    const code = record.nativeKey.split('/')[0]
    return toMgaMasterListEntry(record.raw as MgaRecord, code, record.billId, record.hash, stored.description)
  },

  async fetchMeasure({ billId, sessionId, nativeKey, record, session }, ctx) {
    if (!record || !nativeKey || sessionId === null) throw new Error(`bill ${billId} has no stored MGA record; the MGA sync has not seen it`)
    const r = record.raw as MgaRecord
    const code = nativeKey.split('/')[0]
    const year = Number(code.slice(0, 4))

    const people = await ctx.ids('person', mgaSponsorNames(r))
    const docs = await ctx.ids('doc', mgaDocKeys(code, r))
    const crossfile = r.CrossfileBillNumber?.trim()
    const crossfileKey = crossfile ? mgaNativeKey(code, crossfile) : undefined
    const crossfileId = crossfileKey ? (await ctx.ids('bill', [crossfileKey])).get(crossfileKey) : undefined
    return buildMgaBill(r, code, billId, record.hash, {
      session_id: sessionId,
      session_name: session?.sessionName ?? sessionName(code),
      year_start: session?.yearStart ?? year,
      year_end: session?.yearEnd ?? year,
    }, {
      bill: n => (n === crossfile ? crossfileId : undefined),
      person: name => people.get(name)!,
      doc: key => docs.get(key)!,
    })
  },

  vocabulary,
}

/** "2026RS" → "2026 Regular Session", "2021S1" → "2021 Special Session 1". */
function sessionName(code: string): string {
  const m = /^(\d{4})(RS|S(\d+))$/.exec(code)
  if (!m) return code
  return m[2] === 'RS' ? `${m[1]} Regular Session` : `${m[1]} Special Session ${m[3]}`
}
