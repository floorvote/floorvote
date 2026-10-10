import { getLisFile, lisSessionExists, type LisFile } from './client'
import { buildLisBill, LisAssembler, LIS_FILE_ORDER, LIS_STATE, LIS_STATUS_LABELS, lisCarriedOver, lisNativeKey, lisRecordHash, parseVotes, toLisMasterListEntry, VA_STATE_ID, type LisRecord } from './map'
import type { Provider, ProviderPerson, ProviderRecord, SyncSession } from '../sdk'

/**
 * Virginia's Legislative Information System public data files (client.ts,
 * map.ts): a pass reads one session's CSVs and joins them into a record per
 * bill, and the ingest builds each bill from its stored record with no
 * further calls. Ids come from central's id table. The files need no key, and
 * their requests aren't logged as API calls.
 */
export const lis: Provider<'LIS_STATES'> = {
  id: 'lis',
  envKeys: ['LIS_STATES'],
  states: [LIS_STATE],
  enabled: env => (env.LIS_STATES ?? '').split(',').some(s => s.trim().toUpperCase() === LIS_STATE),

  /**
   * The sessions the LIS has published for this year and next: the regular
   * session and up to two special sessions this year, and next year's regular
   * session once its prefiles appear.
   */
  async listSessions(_state, ctx) {
    const year = Number(ctx.today.slice(0, 4))
    const codes: string[] = []
    for (const code of [`${year}1`, `${year}2`, `${year}3`, `${year + 1}1`]) {
      if (await lisSessionExists(code)) codes.push(code)
    }
    const ids = await ctx.ids('session', codes)
    return codes.map((code): SyncSession => {
      const sessionYear = Number(code.slice(0, 4))
      return {
        session_id: ids.get(code)!,
        session_name: sessionName(code),
        state_id: VA_STATE_ID,
        year_start: sessionYear,
        year_end: sessionYear,
        special: code.endsWith('1') ? 0 : 1,
        session_tag: code,
        prior: 0,
        sine_die: 0,
      }
    })
  },

  // This year's sessions, and next year's once its prefiles appear. A bill
  // continued to next session reappears there, history and all.
  selectSessions(sessions, today) {
    const year = Number(today.slice(0, 4))
    return sessions.filter(s => s.yearStart >= year)
  },

  async snapshot(session, ctx) {
    const code = session.sessionTag
    const fetchFile = (file: LisFile) => getLisFile(code, file)
    // One file at a time, each folded in and let go before the next: a
    // session's files are about 16 MB of text.
    const bills = await fetchFile('bills')
    if (!bills) return { records: [] }
    const assembler = new LisAssembler(bills)
    for (const file of LIS_FILE_ORDER) if (file !== 'bills') assembler.add(file, await fetchFile(file))
    const { records, members } = assembler.result()

    // Members as people, so votes and patrons resolve to names. Member ids are
    // stable across sessions.
    const personIds = await ctx.ids('person', members.map(m => m.id))
    const people = members.map((m): ProviderPerson => ({
      people_id: personIds.get(m.id)!,
      state_id: VA_STATE_ID,
      role: m.chamber === 'S' ? 'Senator' : 'Delegate',
      role_id: m.chamber === 'S' ? 2 : 1,
      name: m.name,
    }))

    const ids = await ctx.ids('bill', [...records.keys()].map(n => lisNativeKey(code, n)))
    return {
      people,
      records: await Promise.all([...records.values()].map(async (rec): Promise<ProviderRecord> => ({
        billId: ids.get(lisNativeKey(code, rec.bill.Bill_id))!,
        nativeKey: lisNativeKey(code, rec.bill.Bill_id),
        raw: rec,
        hash: await lisRecordHash(rec),
      }))),
    }
  },

  async toEntry(record) {
    const code = record.nativeKey.split('/')[0]
    return toLisMasterListEntry(record.raw as LisRecord, code, record.billId, record.hash)
  },

  async fetchMeasure({ billId, sessionId, nativeKey, record, session }, ctx) {
    if (!record || !nativeKey || sessionId === null) throw new Error(`bill ${billId} has no stored LIS record; the LIS sync has not seen it`)
    const rec = record.raw as LisRecord
    const code = nativeKey.split('/')[0]
    const year = Number(code.slice(0, 4))

    const memberIds = [...rec.sponsors.map(sp => sp[0]), ...Object.values(rec.votes).flatMap(v => parseVotes(v).map(p => p[0]))]
    const persons = await ctx.ids('person', memberIds)
    const rollCalls = await ctx.ids('rollcall', Object.keys(rec.votes).map(r => `${code}/${r}`))
    const docs = await ctx.ids('doc', rec.fiscal.map(f => f[1]))
    const carriedKey = lisCarriedOver(rec, year) ? lisNativeKey(`${year - 1}1`, rec.bill.Bill_id) : undefined
    const carriedFrom = carriedKey ? (await ctx.ids('bill', [carriedKey])).get(carriedKey) : undefined

    return buildLisBill(rec, code, billId, record.hash, {
      session_id: sessionId,
      session_name: session?.sessionName ?? sessionName(code),
      year_start: session?.yearStart ?? year,
      year_end: session?.yearEnd ?? year,
    }, {
      person: id => persons.get(id)!,
      rollCall: refid => rollCalls.get(`${code}/${refid}`)!,
      doc: url => docs.get(url)!,
      carriedFrom,
    })
  },

  statusLabels: LIS_STATUS_LABELS,
}

const ROMAN = ['', 'I', 'II', 'III', 'IV']

/** "20261" → "2026 Regular Session", "20262" → "2026 Special Session I". */
function sessionName(code: string): string {
  const year = code.slice(0, 4)
  const n = Number(code.slice(4))
  return n === 1 ? `${year} Regular Session` : `${year} Special Session ${ROMAN[n - 1] ?? n - 1}`
}
