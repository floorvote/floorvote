import { getLisFile, getLisFileEtag, lisSessionExists, LIS_FILES, type LisFile } from './client'
import {
  buildLisBill, LisAssembler, LIS_FILE_ORDER, LIS_REQUIRED_FILES, LIS_STATE, lisCarriedFromCandidates, lisCommitteeKeys,
  lisNativeKey, lisRecordHash, parseVotes, toLisMasterListEntry, VA_STATE_ID, type LisRecord,
} from './map'
import { vocabulary } from './vocabulary'
import type { Provider, ProviderContext, ProviderPerson, ProviderRecord, ProviderSnapshot, SyncSession } from '../sdk'

/**
 * Virginia's Legislative Information System public data files (client.ts,
 * map.ts): a pass reads one session's CSVs and joins them into a record per
 * bill, and the ingest builds each bill from its stored record with no
 * further calls. Ids come from central's id table. The files need no key, and
 * their requests aren't logged as API calls.
 */
export const lis: Provider<'LIS_STATES'> = {
  id: 'lis',
  // The publisher, as members know it, like "Maryland General Assembly".
  // "LIS" is the name of the system, which members don't need to know.
  displayName: 'Virginia General Assembly',
  envKeys: ['LIS_STATES'],
  states: [LIS_STATE],
  statesEnvKey: 'LIS_STATES',

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
  // continued to another session reappears there, history and all.
  selectSessions(sessions, today) {
    const year = Number(today.slice(0, 4))
    return sessions.filter(s => s.yearStart >= year)
  },

  /**
   * One session's files, joined into a record per bill.
   *
   * ETags: the session's stored ETag is every file's ETag, packed into one
   * string (`packEtags`). When there is one, a HEAD request per file checks
   * them first, and if no file changed (or appeared, or went), the pass reads
   * nothing more and reports the session unchanged. Otherwise it reads every
   * file, since each bill's record joins all of them.
   *
   * Fails closed: a file the session must publish that is missing (a 404),
   * cut short, or shaped differently throws, so the pass writes nothing from
   * that answer and no bill is rebuilt without its history, patrons, or
   * votes. See `checkMissing` for which files may be missing.
   */
  async snapshot(session, ctx): Promise<ProviderSnapshot> {
    const code = session.sessionTag
    const stored = unpackEtags(session.etag)
    if (stored && await unchangedSince(code, stored)) return { records: [], unchanged: true }

    // One file at a time, each folded in and let go before the next: a
    // session's files are about 16 MB of text.
    const etags: Record<string, string> = {}
    let assembler: LisAssembler | null = null
    for (const file of LIS_FILE_ORDER) {
      const read = await getLisFile(code, file)
      // An empty file is as good as a missing one.
      if (!read || read.text === '') {
        checkMissing(code, file, assembler, stored)
        continue
      }
      etags[file] = read.etag ?? ''
      if (file === 'bills') assembler = new LisAssembler(code, read.text)
      else assembler!.add(file, read.text)
    }
    const { records, members } = assembler!.result()
    return {
      records: await toRecords(code, records, ctx),
      people: await toPeople(members, ctx),
      etag: packEtags(etags),
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
    const committees = await ctx.ids('committee', lisCommitteeKeys(rec))
    // The earlier session's copy of a carried-over bill, if central holds it:
    // never minted here, so a session central never synced links nothing.
    const candidates = lisCarriedFromCandidates(rec, code)
    const known = candidates.length > 0 ? await ctx.knownIds('bill', candidates) : new Map<string, number>()
    const carriedFrom = candidates.map(k => known.get(k)).find(id => id !== undefined)

    return buildLisBill(rec, code, billId, record.hash, {
      session_id: sessionId,
      session_name: session?.sessionName ?? sessionName(code),
      year_start: session?.yearStart ?? year,
      year_end: session?.yearEnd ?? year,
    }, {
      person: id => persons.get(id)!,
      rollCall: refid => rollCalls.get(`${code}/${refid}`)!,
      doc: url => docs.get(url)!,
      committee: key => committees.get(key)!,
      carriedFrom,
    })
  },

  vocabulary,
}

/**
 * Throws unless a session may lack this file. A session publishes its bills,
 * history, patrons, summaries, members, and committees from its first
 * prefiled bill (LIS_REQUIRED_FILES). The others appear as the session gets to
 * them: votes once the history records a counted vote this session, fiscal
 * impact statements once it records one, and Senate dockets once committees
 * meet. Before that, a 404 is the session not having one yet. And a file the
 * last finished pass read can't go missing.
 */
function checkMissing(code: string, file: LisFile, assembler: LisAssembler | null, stored: Record<string, string> | null): void {
  const missing = `LIS ${code}: ${LIS_FILES[file]} is missing`
  if (LIS_REQUIRED_FILES.includes(file)) throw new Error(missing)
  if (stored && file in stored) throw new Error(`${missing}, though the last pass read it`)
  if ((file === 'votes' || file === 'fiscal') && assembler?.expects(file)) {
    throw new Error(`${missing}, though this session's history records ${file === 'votes' ? 'counted votes' : 'fiscal impact statements'}`)
  }
}

/** Whether every file's ETag is still the one stored, and no file appeared or went. */
async function unchangedSince(code: string, stored: Record<string, string>): Promise<boolean> {
  for (const file of LIS_FILE_ORDER) {
    const etag = await getLisFileEtag(code, file)
    // A file served without an ETag ('') can't be compared, so reads as changed.
    if (etag === null ? file in stored : etag === '' || stored[file] !== etag) return false
  }
  return true
}

/** The files' ETags as the session's one stored string, by file: `{"bills":"0x8DE...",...}`. A file the session lacks has no key. */
export function packEtags(etags: Record<string, string>): string {
  return JSON.stringify(etags)
}

/** The stored string back as ETags by file, or null for none (or one this code didn't write). */
export function unpackEtags(etag: string | null): Record<string, string> | null {
  if (!etag) return null
  try {
    const parsed = JSON.parse(etag) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    const files = Object.entries(parsed)
    if (!files.every(([file, v]) => file in LIS_FILES && typeof v === 'string')) return null
    return Object.fromEntries(files) as Record<string, string>
  } catch {
    return null
  }
}

async function toRecords(code: string, records: Map<string, LisRecord>, ctx: ProviderContext): Promise<ProviderRecord[]> {
  const ids = await ctx.ids('bill', [...records.keys()].map(n => lisNativeKey(code, n)))
  return Promise.all([...records.values()].map(async (rec): Promise<ProviderRecord> => ({
    billId: ids.get(lisNativeKey(code, rec.bill.Bill_id))!,
    nativeKey: lisNativeKey(code, rec.bill.Bill_id),
    raw: rec,
    hash: await lisRecordHash(rec),
  })))
}

/** Members as people, so votes and patrons resolve to names. Member ids are stable across sessions. */
async function toPeople(members: { id: string; name: string; chamber: 'H' | 'S' }[], ctx: ProviderContext): Promise<ProviderPerson[]> {
  const personIds = await ctx.ids('person', members.map(m => m.id))
  return members.map((m): ProviderPerson => ({
    people_id: personIds.get(m.id)!,
    state_id: VA_STATE_ID,
    role: m.chamber === 'S' ? 'Senator' : 'Delegate',
    role_id: m.chamber === 'S' ? 2 : 1,
    name: m.name,
  }))
}

const ROMAN = ['', 'I', 'II', 'III', 'IV']

/** "20261" → "2026 Regular Session", "20262" → "2026 Special Session I". */
function sessionName(code: string): string {
  const year = code.slice(0, 4)
  const n = Number(code.slice(4))
  return n === 1 ? `${year} Regular Session` : `${year} Special Session ${ROMAN[n - 1] ?? n - 1}`
}
