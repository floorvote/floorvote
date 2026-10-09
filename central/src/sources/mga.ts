import { eq, and, lt } from 'drizzle-orm'
import { getMgaSession, mgaSessionExists, type MgaRecord } from '../lib/mga'
import { buildMgaBill, MD_STATE_ID, MGA_STATE, MGA_STATUS_LABELS, mgaDocKeys, mgaNativeKey, mgaRecordHash, mgaSponsorNames, toMgaMasterListEntry } from '../lib/mga-map'
import { sourceIdFor, sourceIdsFor } from '../lib/sourceIds'
import { sessions, sourceRecords } from '../db/schema'
import type { DirectSource, SessionRow, SourceRecord } from './types'
import type { Db } from '../types'

/**
 * The Maryland General Assembly's open data (lib/mga.ts, lib/mga-map.ts): one
 * JSON file per session with every bill, so a pass is one request and a bill
 * is built from its stored record with no further calls.
 */
export const mgaSource: DirectSource = {
  id: 'mga',
  states: [MGA_STATE],
  enabled: env => (env.MGA_STATES ?? '').split(',').some(s => s.trim().toUpperCase() === MGA_STATE),

  async syncSessions(_env, db, ctx) {
    const year = Number(ctx.today.slice(0, 4))
    // Sessions appear at most a few times a year: look daily, or now if this
    // central has never seen one.
    const known = await mgaSessionRows(db)
    if (ctx.force || ctx.etHour === 5 || known.length === 0) await refreshMgaSessions(db, year)
    // This year's sessions keep syncing after sine die: the Governor signs and
    // vetoes into late May. Next year's regular session appears with its prefiles.
    return (await mgaSessionRows(db)).filter(s => s.yearStart >= year)
  },

  async snapshot(session, _env, db) {
    const code = session.sessionTag
    const rows = await getMgaSession(code)
    if (!rows) return []
    const ids = await sourceIdsFor(db, 'mga', 'bill', rows.map(r => mgaNativeKey(code, r.BillNumber)))
    return Promise.all(rows.map(async (r): Promise<SourceRecord> => ({
      billId: ids.get(mgaNativeKey(code, r.BillNumber))!,
      nativeKey: mgaNativeKey(code, r.BillNumber),
      raw: r,
      hash: await mgaRecordHash(r),
    })))
  },

  async toEntry(record, stored) {
    const code = record.nativeKey.split('/')[0]
    return toMgaMasterListEntry(record.raw as MgaRecord, code, record.billId, record.hash, stored.description)
  },

  async buildBill(billId, _env, db) {
    const row = await db.select().from(sourceRecords)
      .where(and(eq(sourceRecords.billId, billId), eq(sourceRecords.source, 'mga'))).get()
    if (!row) throw new Error(`bill ${billId} has no stored MGA record; the MGA sync has not seen it`)
    const r = JSON.parse(row.rawJson) as MgaRecord
    const code = row.nativeKey.split('/')[0]
    const s = await db.select().from(sessions).where(eq(sessions.sessionId, row.sessionId)).get()
    const year = Number(code.slice(0, 4))

    const people = await sourceIdsFor(db, 'mga', 'person', mgaSponsorNames(r))
    const docs = await sourceIdsFor(db, 'mga', 'doc', mgaDocKeys(code, r))
    const crossfile = r.CrossfileBillNumber?.trim()
    const crossfileId = crossfile ? await sourceIdFor(db, 'mga', 'bill', mgaNativeKey(code, crossfile)) : undefined
    return buildMgaBill(r, code, billId, row.rawHash, {
      session_id: row.sessionId,
      session_name: s?.sessionName ?? sessionName(code),
      year_start: s?.yearStart ?? year,
      year_end: s?.yearEnd ?? year,
    }, {
      bill: n => (n === crossfile ? crossfileId : undefined),
      person: name => people.get(name)!,
      doc: key => docs.get(key)!,
    })
  },

  statusLabels: MGA_STATUS_LABELS,
}

function mgaSessionRows(db: Db): Promise<SessionRow[]> {
  return db.select().from(sessions).where(and(eq(sessions.state, MGA_STATE), eq(sessions.source, 'mga'))).all()
}

/** "2026RS" → "2026 Regular Session", "2021S1" → "2021 Special Session 1". */
function sessionName(code: string): string {
  const m = /^(\d{4})(RS|S(\d+))$/.exec(code)
  if (!m) return code
  return m[2] === 'RS' ? `${m[1]} Regular Session` : `${m[1]} Special Session ${m[3]}`
}

/**
 * Upsert the sessions the MGA has published for this year and next: the
 * regular session and up to two special sessions this year (one HEAD request
 * each), and next year's regular session once its prefiles appear. Earlier
 * years' sessions become prior.
 */
async function refreshMgaSessions(db: Db, year: number): Promise<void> {
  const candidates = [`${year}RS`, `${year}S1`, `${year}S2`, `${year + 1}RS`]
  for (const code of candidates) {
    if (!(await mgaSessionExists(code))) continue
    const sessionYear = Number(code.slice(0, 4))
    const values = {
      sessionId: await sourceIdFor(db, 'mga', 'session', code),
      state: MGA_STATE,
      stateId: MD_STATE_ID,
      yearStart: sessionYear,
      yearEnd: sessionYear,
      special: /S\d+$/.test(code) ? 1 : 0,
      sessionTag: code,
      sessionTitle: sessionName(code),
      sessionName: sessionName(code),
      prior: 0,
      sineDie: 0,
      source: 'mga',
    }
    await db.insert(sessions).values(values).onConflictDoUpdate({
      target: sessions.sessionId,
      set: { sessionTitle: values.sessionTitle, sessionName: values.sessionName, prior: 0 },
    })
  }
  await db.update(sessions).set({ prior: 1 })
    .where(and(eq(sessions.source, 'mga'), lt(sessions.yearStart, year)))
}
