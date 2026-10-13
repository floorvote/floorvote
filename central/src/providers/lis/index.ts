import { getLisFile, getLisFileEtag, getLisTextList, getLisTextPdf, lisSessionExists, LIS_FILES, type LisFile } from './client'
import {
  buildLisBill, LisAssembler, LIS_FILE_ORDER, LIS_REQUIRED_FILES, LIS_STATE, lisCarriedFromCandidates, lisCommitteeKeys,
  lisNativeKey, lisRecordHash, lisRollCallKey, lisTextDocKey, lisVoteHasTally, parseVotes, toLisMasterListEntry, VA_STATE_ID, type LisRecord,
} from './map'
import { vocabulary } from './vocabulary'
import type { Provider, ProviderContext, ProviderPerson, ProviderRecord, ProviderSnapshot, SyncSession } from '../sdk'

/**
 * Virginia's Legislative Information System public data files (client.ts,
 * map.ts): a pass reads one session's CSVs and joins them into a record per
 * bill, and the ingest builds each bill from its stored record. Ids come from
 * central's id table. The files need no key, and their requests aren't logged
 * as API calls.
 *
 * Bill text is the one thing the files lack. With the optional `LIS_API_KEY`,
 * a pass makes one more call (the session's text list, onto each bill's
 * record), and an ingest makes one call per text version for its PDF link.
 * Those calls are logged as `lis:<operation>`. Without the key there are no
 * such calls and `texts` is empty, as it was before the API was used. The
 * provider runs, and can be claimed, either way (no `configured`).
 */
export const lis: Provider<'LIS_API_KEY'> = {
  id: 'lis',
  // The publisher, as members know it, like "Maryland General Assembly".
  // "LIS" is the name of the system, which members don't need to know.
  displayName: 'Virginia General Assembly',
  attribution: {
    name: 'Virginia Legislative Information System',
    url: 'https://lis.virginia.gov',
  },
  coverage: { maintainers: ['anotherpanacea-eng'] },
  envKeys: ['LIS_API_KEY'],
  states: [LIS_STATE],
  // A bill's record carries every vote (VOTE.CSV is read whole or the pass fails).
  replacesRollCalls: true,

  /**
   * The sessions the LIS has published for this year and next: the regular
   * session and up to three special sessions this year, and next year's
   * regular session once its prefiles appear.
   */
  async listSessions(_state, ctx) {
    const year = Number(ctx.today.slice(0, 4))
    const codes: string[] = []
    for (const code of [`${year}1`, `${year}2`, `${year}3`, `${year}4`, `${year + 1}1`]) {
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
   * versioned string (`packEtags`) with whether the pass read bill text. When
   * there is one, a HEAD request per file checks them first, and if no file
   * changed (or appeared, or went), and the text setting is the one the ETag
   * was packed with, the pass reads nothing more and reports the session
   * unchanged. Otherwise it reads every file, since each bill's record joins
   * all of them. Adding or removing the key is a change of setting: without
   * that, the files would stay as they were and the key would do nothing until
   * they changed.
   *
   * With a key, a pass that reads the files also makes one call for the
   * session's text list and adds each bill's full-text versions to its record
   * (`LisAssembler.addTexts`). An error from that call fails the pass.
   *
   * Fails closed: a file the session must publish that is missing (a 404),
   * cut short, or shaped differently throws, so the pass writes nothing from
   * that answer and no bill is rebuilt without its history, patrons, or
   * votes. See `checkMissing` for which files may be missing, and
   * LisAssembler.check for files cut down to their header.
   */
  async snapshot(session, ctx): Promise<ProviderSnapshot> {
    const code = session.sessionTag
    const apiKey = ctx.env.LIS_API_KEY || undefined
    const packed = unpackEtags(session.etag)
    const stored = packed?.files ?? null
    if (stored && packed!.texts === !!apiKey && await unchangedSince(code, stored)) return { records: [], unchanged: true }

    // One file at a time, each folded in and let go before the next: a
    // session's files are about 16 MB of text.
    const etags: Record<string, string> = {}
    let assembler: LisAssembler | null = null
    for (const file of LIS_FILE_ORDER) {
      const read = await getLisFile(code, file)
      // An empty file is as good as a missing one. Its ETag is kept, marked,
      // so the next pass's check sees it unchanged rather than appeared.
      if (!read || read.text === '') {
        checkMissing(code, file, assembler, stored)
        if (read) etags[file] = `${EMPTY}${read.etag ?? ''}`
        continue
      }
      etags[file] = read.etag ?? ''
      if (file === 'bills') assembler = new LisAssembler(code, read.text)
      else assembler!.add(file, read.text)
    }
    assembler!.check(packed?.docketed ?? false)
    if (apiKey) {
      assembler!.addTexts(await getLisTextList(code, apiKey, () => ctx.logCall('lis:getlegislationtextlistasync', { sessionCode: code })))
    }
    const { records, members } = assembler!.result()
    return {
      records: await toRecords(code, records, ctx),
      people: await toPeople(members, ctx),
      etag: packEtags(etags, assembler!.docketed, !!apiKey),
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

    // Only counted votes become roll calls (a voice vote has no tally), and a
    // roll call's id is the bill's own: a block vote's reference id is shared
    // by every bill on it (lisRollCallKey).
    const counted = Object.entries(rec.votes).filter(([, v]) => lisVoteHasTally(v))
    const memberIds = [...rec.sponsors.map(sp => sp[0]), ...counted.flatMap(([, v]) => parseVotes(v).map(p => p[0]))]
    const persons = await ctx.ids('person', memberIds)
    const rollKey = (refid: string) => lisRollCallKey(code, rec.bill.Bill_id, refid)
    const rollCalls = await ctx.ids('rollcall', counted.map(([refid]) => rollKey(refid)))
    // Each text version's PDF link, from the API. Without a key there are none, so no texts, and no call.
    const apiKey = ctx.env.LIS_API_KEY || undefined
    const pdfs = new Map<number, string>()
    const versions = apiKey ? rec.texts ?? [] : []
    for (const [textId] of versions) {
      const link = await getLisTextPdf(textId, apiKey!, () => ctx.logCall('lis:getlegislationtextbyidasync', { legislationTextID: textId }))
      if (link) pdfs.set(textId, link)
    }
    const docs = await ctx.ids('doc', [...rec.fiscal.map(f => f[1]), ...[...pdfs.keys()].map(lisTextDocKey)])
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
      rollCall: refid => rollCalls.get(rollKey(refid))!,
      doc: url => docs.get(url)!,
      committee: key => committees.get(key)!,
      carriedFrom,
    }, pdfs)
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
  if (stored?.[file] !== undefined && !stored[file].startsWith(EMPTY)) throw new Error(`${missing}, though the last pass read it`)
  if ((file === 'votes' || file === 'fiscal') && assembler?.expects(file)) {
    throw new Error(`${missing}, though this session's history records ${file === 'votes' ? 'counted votes' : 'fiscal impact statements'}`)
  }
}

/** Whether every file's ETag is still the one stored, and no file appeared or went. */
async function unchangedSince(code: string, stored: Record<string, string>): Promise<boolean> {
  for (const file of LIS_FILE_ORDER) {
    const etag = await getLisFileEtag(code, file)
    // A file served without an ETag ('') can't be compared, so reads as changed.
    if (etag === null ? file in stored : etag === '' || stored[file]?.replace(EMPTY, '') !== etag) return false
  }
  return true
}

/**
 * The packed ETag's format. Bump it when LisRecord's shape changes: a stored
 * ETag of another version reads as none, so the next pass reads every file
 * and rewrites every stored record, rather than taking a 304 and handing the
 * mapping records of the old shape. (3 added the record's `texts` and the
 * ETag's flag for whether a pass read them.)
 */
const ETAG_VERSION = 3
/** Marks a file the last pass read as empty (an empty file is treated as missing). */
const EMPTY = 'empty:'

/**
 * The files' ETags as the session's one stored string:
 * `{"v":3,"files":{"bills":"0x8DE...",...},"docketed":true,"texts":false}`. A
 * file the session lacks has no key. `docketed` records that some bill was on
 * a docket, so the next pass can tell a docket file cut to its header. `texts`
 * records that the pass read bill text (it had an `LIS_API_KEY`), so a pass
 * with the other setting can't take the files being unchanged for nothing
 * having changed.
 */
export function packEtags(files: Record<string, string>, docketed: boolean, texts: boolean): string {
  return JSON.stringify({ v: ETAG_VERSION, files, docketed, texts })
}

/** The stored string back, or null for none, or one of another version or shape. */
export function unpackEtags(etag: string | null): { files: Record<string, string>; docketed: boolean; texts: boolean } | null {
  if (!etag) return null
  try {
    const parsed = JSON.parse(etag) as { v?: unknown; files?: unknown; docketed?: unknown; texts?: unknown }
    if (parsed?.v !== ETAG_VERSION || typeof parsed.files !== 'object' || parsed.files === null) return null
    const files = Object.entries(parsed.files)
    if (!files.every(([file, v]) => file in LIS_FILES && typeof v === 'string')) return null
    return { files: Object.fromEntries(files) as Record<string, string>, docketed: parsed.docketed === true, texts: parsed.texts === true }
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
