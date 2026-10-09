import { eq, and, lt } from 'drizzle-orm'
import { getLisFile, lisSessionExists, type LisFile } from '../lib/lis'
import { buildLisBill, LisAssembler, LIS_FILE_ORDER, LIS_STATE, LIS_STATUS_LABELS, lisCarriedOver, lisNativeKey, lisRecordHash, parseVotes, toLisMasterListEntry, VA_STATE_ID, type LisMember, type LisRecord } from '../lib/lis-map'
import { sourceIdFor, sourceIdsFor } from '../lib/sourceIds'
import { people, sessions, sourceRecords } from '../db/schema'
import type { DirectSource, SessionRow, SourceRecord } from './types'
import type { Db } from '../types'

/**
 * Virginia's Legislative Information System public data files (lib/lis.ts,
 * lib/lis-map.ts): a pass reads one session's CSVs, joins them into a record per
 * bill, and the ingestor builds each bill from its stored record with no
 * further calls.
 */
export const lisSource: DirectSource = {
  id: 'lis',
  states: [LIS_STATE],
  enabled: env => (env.LIS_STATES ?? '').split(',').some(s => s.trim().toUpperCase() === LIS_STATE),

  async syncSessions(_env, db, ctx) {
    const year = Number(ctx.today.slice(0, 4))
    const known = await lisSessionRows(db)
    if (ctx.force || ctx.etHour === 5 || known.length === 0) await refreshLisSessions(db, year)
    // This year's sessions, and next year's once its prefiles appear. A bill
    // continued to next session reappears there, history and all.
    return (await lisSessionRows(db)).filter(s => s.yearStart >= year)
  },

  async snapshot(session, _env, db) {
    const code = session.sessionTag
    const fetchFile = (file: LisFile) => getLisFile(code, file)
    // One file at a time, each folded in and let go before the next: a
    // session's files are about 16 MB of text.
    const bills = await fetchFile('bills')
    if (!bills) return []
    const assembler = new LisAssembler(bills)
    for (const file of LIS_FILE_ORDER) if (file !== 'bills') assembler.add(file, await fetchFile(file))
    const { records, members } = assembler.result()
    await upsertMembers(db, members)
    const ids = await sourceIdsFor(db, 'lis', 'bill', [...records.keys()].map(n => lisNativeKey(code, n)))
    return Promise.all([...records.values()].map(async (rec): Promise<SourceRecord> => ({
      billId: ids.get(lisNativeKey(code, rec.bill.Bill_id))!,
      nativeKey: lisNativeKey(code, rec.bill.Bill_id),
      raw: rec,
      hash: await lisRecordHash(rec),
    })))
  },

  async toEntry(record) {
    const code = record.nativeKey.split('/')[0]
    return toLisMasterListEntry(record.raw as LisRecord, code, record.billId, record.hash)
  },

  async buildBill(billId, _env, db) {
    const row = await db.select().from(sourceRecords)
      .where(and(eq(sourceRecords.billId, billId), eq(sourceRecords.source, 'lis'))).get()
    if (!row) throw new Error(`bill ${billId} has no stored LIS record; the LIS sync has not seen it`)
    const rec = JSON.parse(row.rawJson) as LisRecord
    const code = row.nativeKey.split('/')[0]
    const year = Number(code.slice(0, 4))
    const s = await db.select().from(sessions).where(eq(sessions.sessionId, row.sessionId)).get()

    const memberIds = [...rec.sponsors.map(sp => sp[0]), ...Object.values(rec.votes).flatMap(v => parseVotes(v).map(p => p[0]))]
    const persons = await sourceIdsFor(db, 'lis', 'person', memberIds)
    const rollCalls = await sourceIdsFor(db, 'lis', 'rollcall', Object.keys(rec.votes).map(r => `${code}/${r}`))
    const docs = await sourceIdsFor(db, 'lis', 'doc', rec.fiscal.map(f => f[1]))
    const carriedFrom = lisCarriedOver(rec, year)
      ? await sourceIdFor(db, 'lis', 'bill', lisNativeKey(`${year - 1}1`, rec.bill.Bill_id))
      : undefined

    return buildLisBill(rec, code, billId, row.rawHash, {
      session_id: row.sessionId,
      session_name: s?.sessionName ?? sessionName(code),
      year_start: s?.yearStart ?? year,
      year_end: s?.yearEnd ?? year,
    }, {
      person: id => persons.get(id)!,
      rollCall: refid => rollCalls.get(`${code}/${refid}`)!,
      doc: url => docs.get(url)!,
      carriedFrom,
    })
  },

  statusLabels: LIS_STATUS_LABELS,
}

function lisSessionRows(db: Db): Promise<SessionRow[]> {
  return db.select().from(sessions).where(and(eq(sessions.state, LIS_STATE), eq(sessions.source, 'lis'))).all()
}

const ROMAN = ['', 'I', 'II', 'III', 'IV']

/** "20261" → "2026 Regular Session", "20262" → "2026 Special Session I". */
function sessionName(code: string): string {
  const year = code.slice(0, 4)
  const n = Number(code.slice(4))
  return n === 1 ? `${year} Regular Session` : `${year} Special Session ${ROMAN[n - 1] ?? n - 1}`
}

/**
 * Upsert the sessions the LIS has published for this year and next: the
 * regular session and up to two special sessions this year, and next year's
 * regular session once its prefiles appear. Earlier years' sessions become prior.
 */
async function refreshLisSessions(db: Db, year: number): Promise<void> {
  for (const code of [`${year}1`, `${year}2`, `${year}3`, `${year + 1}1`]) {
    if (!(await lisSessionExists(code))) continue
    const sessionYear = Number(code.slice(0, 4))
    const values = {
      sessionId: await sourceIdFor(db, 'lis', 'session', code),
      state: LIS_STATE,
      stateId: VA_STATE_ID,
      yearStart: sessionYear,
      yearEnd: sessionYear,
      special: code.endsWith('1') ? 0 : 1,
      sessionTag: code,
      sessionTitle: sessionName(code),
      sessionName: sessionName(code),
      prior: 0,
      sineDie: 0,
      source: 'lis',
    }
    await db.insert(sessions).values(values).onConflictDoUpdate({
      target: sessions.sessionId,
      set: { sessionTitle: values.sessionTitle, sessionName: values.sessionName, prior: 0 },
    })
  }
  await db.update(sessions).set({ prior: 1 }).where(and(eq(sessions.source, 'lis'), lt(sessions.yearStart, year)))
}

/** Members as people, so votes and patrons resolve to names. Member ids are stable across sessions. */
async function upsertMembers(db: Db, members: LisMember[]): Promise<void> {
  if (members.length === 0) return
  const ids = await sourceIdsFor(db, 'lis', 'person', members.map(m => m.id))
  const stmts = members.map(m => {
    const values = {
      peopleId: ids.get(m.id)!,
      stateId: VA_STATE_ID,
      role: m.chamber === 'S' ? 'Senator' : 'Delegate',
      roleId: m.chamber === 'S' ? 2 : 1,
      name: m.name,
      source: 'lis',
    }
    const { peopleId: _id, ...update } = values
    return db.insert(people).values(values).onConflictDoUpdate({ target: people.peopleId, set: update })
  })
  await db.batch(stmts as [typeof stmts[0], ...typeof stmts])
}
