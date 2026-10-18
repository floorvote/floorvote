import { htmlToText, sha256Hex, type CentralMeasure, type SyncEntry } from '../sdk'
import type { LisFile, LisTextRow } from './client'
import { CsvError, forEachCsvRecord, forEachCsvRow } from './csv'
import { LIS_STATUS_BASE } from './vocabulary'

/**
 * Mapping from Virginia's LIS data files (client.ts) to the LegiScan shapes
 * the central pipeline ingests. No I/O: ids come in through `LisIds`.
 *
 * A session's files are joined into one record per bill (LisAssembler): the
 * BILLS row, its full history, patrons, summaries, fiscal impact statements,
 * per-member votes, and committee docket placements. The record is stored
 * whole, so the ingestor builds a bill with no further calls.
 *
 * Bill text is not in the files. It comes from the LIS API when the deployment
 * sets an optional `LIS_API_KEY` (the API's terms allow non-commercial use
 * only): a pass adds each bill's text versions to its record (`addTexts`), and
 * the ingest fetches each version's PDF link (client.ts). Without the key,
 * `texts` is empty. The latest summary is the bill's description either way.
 */

export const LIS_STATE = 'VA'
/** LegiScan's state_id for Virginia, so LIS rows look like VA rows everywhere. */
export const VA_STATE_ID = 46

/** Virginia's status codes (vocabulary.ts), named for the step. The files have none. */
export const LIS_STATUS = {
  introduced: LIS_STATUS_BASE + 1,
  inCommittee: LIS_STATUS_BASE + 2,
  continuedFromLastSession: LIS_STATUS_BASE + 3,
  continuedToNextSession: LIS_STATUS_BASE + 4,
  passedHouse: LIS_STATUS_BASE + 5,
  passedSenate: LIS_STATUS_BASE + 6,
  passedGeneralAssembly: LIS_STATUS_BASE + 7,
  failed: LIS_STATUS_BASE + 8,
  vetoed: LIS_STATUS_BASE + 9,
  agreedTo: LIS_STATUS_BASE + 10,
  approved: LIS_STATUS_BASE + 11,
  enacted: LIS_STATUS_BASE + 12,
} as const

/** One history entry: [YYYY-MM-DD, description, reference id]. */
export type LisHistoryEntry = [string, string, string]

/** One bill's slice of a session's files. */
export interface LisRecord {
  /** The BILLS.CSV row, keyed by its header. */
  bill: Record<string, string>
  /**
   * The history, one line per entry in the file's order, each
   * "YYYY-MM-DD<tab>description<tab>reference id" (read it with lisHistory).
   * One string rather than rows, like `votes`: a session has 65,000 history
   * entries, and as arrays they were half the memory a pass assembles.
   */
  history: string
  /** [member id, name, patron type ("1 - Chief Patron")]. */
  sponsors: [string, string, string][]
  /** [summary type, plain text] for each summary, in the file's order. */
  summaries: [string, string][]
  /** [reference id, PDF URL] for each fiscal impact statement. */
  fiscal: [string, string][]
  /**
   * Per-member votes by history reference id, as "H0056N,H0108Y,...": each
   * member id followed by its vote (Y, N, X not voting, A abstain). A string
   * rather than pairs keeps a session's records small enough to assemble in a
   * Worker (11,000 votes of up to 100 members each).
   */
  votes: Record<string, string>
  /**
   * [YYYY-MM-DD, docket description] for each committee or subcommittee
   * docket. Null when the pass read neither docket file (a session whose
   * committees haven't met), so the bill's calendar says nothing rather than
   * that it is empty.
   */
  dockets: [string, string][] | null
  /**
   * The bill's full-text versions from the LIS API, oldest first. Absent when
   * the pass read no texts (no key) or the bill has none, so a deployment
   * without a key stores the records it always did. A new version changes the
   * record's hash, which queues the bill for an ingest.
   */
  texts?: LisTextVersion[]
}

/** One version of a bill's text: [LIS text id, document code (trimmed), version, description, draft date (YYYY-MM-DD)]. */
export type LisTextVersion = [id: number, code: string, version: string, description: string, date: string]

/**
 * Whether the API's version id (`LegislationVersionID`) is a full text of the
 * bill: 1 Introduced, 2 Engrossed, 3 Enrolled, 4 Chaptered, 5 Substitute, 6
 * Reengrossed, 7 Reenrolled. 8 through 11 are amendments, veto explanations,
 * governor's recommendations, and conference reports, which are not the bill,
 * and AI would read an amendment as the bill's newest text.
 */
export function lisIsFullText(versionId: number): boolean {
  return Number.isInteger(versionId) && versionId >= 1 && versionId <= 7
}

const LIS_VERSION_NAMES: Record<number, string> = {
  1: 'Introduced', 2: 'Engrossed', 3: 'Enrolled', 4: 'Chaptered', 5: 'Substitute', 6: 'Reengrossed', 7: 'Reenrolled',
}

/** LegiScan's text type ids, which a bill's texts carry: the closest of them to each LIS version. */
const TEXT_TYPE_IDS: Record<string, number> = {
  Introduced: 1, Substitute: 2, Engrossed: 4, Reengrossed: 4, Enrolled: 5, Reenrolled: 5, Chaptered: 6,
}

/**
 * A bill number from the text API as the CSVs key it (`lisBillNumber`). The
 * API writes joint resolutions as HJ and SJ, as the files do, and LegiScan
 * writes them HJR and SJR, so both spellings land on the same bill.
 */
export function lisTextBillNumber(s: string): string {
  return lisBillNumber(s.replace(/\s+/g, '')).replace(/^([HS]J)R(?=\d)/, '$1')
}

/**
 * A text's `text_hash`: the session, the trimmed document code, and the LIS
 * text id. LIMS and MGA hash a document id the same way: stable, different for
 * each reading, so a bill's newest text changes the hash, and not empty, since
 * instances run AI only for texts that carry a hash and compare it to skip one
 * the model already read. The id is part of it because the LIS reuses a
 * document code across versions (a substitute written as "SB34" after the
 * introduced "SB34"), which the code alone would hash alike.
 */
export function lisTextHash(sessionCode: string, code: string, textId: number): Promise<string> {
  return sha256Hex(`lis-text:${sessionCode}:${code.trim()}:${textId}`)
}

/** The key a text version has in central's id table (kind 'doc', beside the fiscal impact statements' URLs). */
export function lisTextDocKey(textId: number): string {
  return `text:${textId}`
}

export interface LisMember { id: string; name: string; chamber: 'H' | 'S' }

/** "HB0001 " or "hb1" → "HB1". */
export function lisBillNumber(s: string): string {
  const t = s.trim().toUpperCase()
  const m = /^([A-Z]+)0*(\d+)$/.exec(t)
  return m ? `${m[1]}${m[2]}` : t
}

/** "1/20/2026" or "01/20/2026" → "2026-01-20". */
export function lisDate(s: string): string {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s.trim())
  return m ? `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : ''
}

/** The bill's key in provider_ids and provider_records: "20261/HB1". */
export function lisNativeKey(sessionCode: string, billNumber: string): string {
  return `${sessionCode}/${lisBillNumber(billNumber)}`
}

/** The order files are folded in: votes attach to history entries, so history comes first. */
export const LIS_FILE_ORDER = ['bills', 'history', 'votes', 'sponsors', 'summaries', 'fiscal', 'committees', 'dockets', 'subdockets', 'members'] as const satisfies readonly LisFile[]

/**
 * Files every session publishes from its first prefiled bill: a pass fails
 * without any of them, since a bill rebuilt without its history or patrons
 * would lose them. The others appear as the session reaches them (votes,
 * fiscal impact statements, Senate dockets), and LisAssembler.expects says
 * when one must be there.
 */
export const LIS_REQUIRED_FILES: readonly LisFile[] = ['bills', 'history', 'sponsors', 'summaries', 'members', 'committees']

/** The columns the mapping reads, by file. A file without one fails the pass. VOTE.CSV has no header. */
const COLUMNS: Record<Exclude<LisFile, 'votes'>, readonly string[]> = {
  bills: ['Bill_id', 'Bill_description', 'Emergency', 'Passed_house', 'Passed_senate', 'Passed', 'Failed', 'Carried_over', 'Approved', 'Vetoed', 'Chapter_id', 'Introduction_date'],
  history: ['Bill_id', 'History_date', 'History_description', 'History_refid'],
  sponsors: ['MEMBER_NAME', 'MEMBER_ID', 'BILL_NUMBER', 'PATRON_TYPE'],
  summaries: ['SUM_BILNO', 'SUMMARY_TYPE', 'SUMMARY_TEXT'],
  fiscal: ['HST_BILNO', 'HST_REFID', 'HST_URL'],
  dockets: ['Com_no', 'Doc_date', 'Doc_no', 'Bill_no'],
  subdockets: ['Com_no', 'Sub_no', 'Doc_date', 'Bill_no'],
  members: ['MBR_HOU', 'MBR_MBRNO', 'MBR_NAME'],
  committees: ['CHAMBER', 'COM_NAME', 'COM_COMNO'],
}

const VOTE_CODES = new Set(['Y', 'N', 'X', 'A'])
/** A history line that records a counted vote: "(64-Y 34-N 0-A)". */
const TALLY = /\(\d+-Y \d+-N/
const FISCAL_LINE = /Fiscal Impact Statement/i

/**
 * Joins one session's files into a record per bill, plus the session's
 * members, one file at a time: a caller fetches each file, adds it, and lets
 * its text go before fetching the next. A file whose shape isn't what the
 * mapping reads (a missing column, a row cut short, a vote that isn't one of
 * Virginia's four) throws, naming the file.
 */
export class LisAssembler {
  private records = new Map<string, LisRecord>()
  /** The records each history reference id appears in, for attaching votes. Dropped once votes are in. */
  private refs = new Map<string, LisRecord[]>()
  private committees = new Map<string, string>()
  private members: LisMember[] = []
  /** Rows of each file that attached to a bill (or a vote), for check(). */
  private matched: Partial<Record<LisFile, number>> = {}

  constructor(private readonly sessionCode: string, billsCsv: string) {
    this.fold('bills', () => forEachCsvRecord(billsCsv, b => {
      const id = lisBillNumber(b.Bill_id)
      if (id) this.records.set(id, { bill: { ...b, Bill_id: id }, history: '', sponsors: [], summaries: [], fiscal: [], votes: {}, dockets: null })
    }, COLUMNS.bills))
  }

  /**
   * Throws when a file came back with its header but none of the rows a
   * session that far along must have: a history or patrons naming none of
   * the bills, no vote rows for the counted votes this session's history
   * records, or no statements for the ones it records. A file cut down to
   * its header parses cleanly, so the row checks can't catch it, and the
   * ingest would rebuild every bill without it. `docketed` says the last
   * pass found bills on dockets, which then can't all be gone.
   */
  check(docketed = false): void {
    const none = (file: LisFile, why: string) => {
      if (!this.matched[file]) throw new Error(`LIS ${this.sessionCode} ${file}: no rows for ${why}, so the file is truncated`)
    }
    if (this.records.size > 0) {
      none('history', 'any of the bills')
      none('sponsors', 'any of the bills')
    }
    if (this.expects('votes')) none('votes', 'the counted votes this session\'s history records')
    if (this.expects('fiscal')) none('fiscal', 'the fiscal impact statements this session\'s history records')
    if (docketed && !this.matched.dockets && !this.matched.subdockets) {
      throw new Error(`LIS ${this.sessionCode} dockets: no bill is on a docket, though the last pass found some, so the files are truncated`)
    }
  }

  /** Whether any bill is on a docket, for the next pass's check(). */
  get docketed(): boolean {
    return !!(this.matched.dockets || this.matched.subdockets)
  }

  private count(file: LisFile): void {
    this.matched[file] = (this.matched[file] ?? 0) + 1
  }

  /**
   * Adds the API's text list to the bills' records: each bill's full-text
   * versions (`lisIsFullText`), oldest first, with each code trimmed and each
   * date cut to the day, so a draft time that moves doesn't change a record.
   * A row for a bill the files don't have is ignored, and no bill is made for
   * it. A bill with no full text keeps a record with no `texts`.
   */
  addTexts(rows: LisTextRow[]): void {
    const byRecord = new Map<LisRecord, Map<number, LisTextVersion>>()
    for (const r of rows) {
      if (!lisIsFullText(r.LegislationVersionID)) continue
      const rec = this.records.get(lisTextBillNumber(r.LegislationNumber))
      if (!rec) continue
      const version = (r.Version ?? '').trim() || LIS_VERSION_NAMES[r.LegislationVersionID]
      const day = /^\d{4}-\d{2}-\d{2}/.exec(r.DraftDate ?? '')?.[0] ?? ''
      let versions = byRecord.get(rec)
      if (!versions) byRecord.set(rec, versions = new Map())
      versions.set(r.LegislationTextID, [r.LegislationTextID, (r.DocumentCode ?? '').trim(), version, (r.Description ?? '').trim(), day])
    }
    for (const [rec, versions] of byRecord) rec.texts = [...versions.values()].sort((a, b) => a[4].localeCompare(b[4]) || a[0] - b[0])
  }

  result(): { records: Map<string, LisRecord>; members: LisMember[] } {
    this.refs.clear()
    return { records: this.records, members: this.members }
  }

  /**
   * Whether this session's history says a file the session may not publish
   * yet must be there: a counted vote for VOTE.CSV, a fiscal impact statement
   * for FiscalImpactStatements.csv. Only lines from this session count. A
   * carried-over bill brings its earlier session's history along, but that
   * session's votes and statements stay in that session's files.
   */
  expects(file: 'votes' | 'fiscal'): boolean {
    for (const rec of this.records.values()) {
      for (const [, desc, refid] of thisSessionHistory(rec, this.sessionCode)) {
        if (file === 'votes' ? refid && TALLY.test(desc) : FISCAL_LINE.test(desc)) return true
      }
    }
    return false
  }

  add(file: Exclude<LisFile, 'bills'>, text: string): void {
    const records = this.records
    switch (file) {
      case 'history': {
        const lines = new Map<LisRecord, string[]>()
        this.fold(file, () => forEachCsvRecord(text, h => {
          const rec = records.get(lisBillNumber(h.Bill_id))
          if (!rec) return
          this.count('history')
          const line = [lisDate(h.History_date), h.History_description, h.History_refid].map(f => f.replace(/[\t\r\n]+/g, ' ')).join('\t')
          const list = lines.get(rec)
          if (list) list.push(line)
          else lines.set(rec, [line])
          if (!h.History_refid) return
          const recs = this.refs.get(h.History_refid)
          if (recs) recs.push(rec)
          else this.refs.set(h.History_refid, [rec])
        }, COLUMNS.history))
        // Joined, each bill's lines are one new string, which lets the file's text go.
        for (const [rec, list] of lines) rec.history = list.join('\n')
        return
      }
      case 'votes':
        // Wide rows: a vote id, then member id and vote pairs. The first line
        // is a count, and a vote with no member rows (a voice vote) is just its id.
        return this.fold(file, () => forEachCsvRow(text, (row, line) => {
          if (line === 1) return
          if (row.length === 1) return
          if (row.length % 2 === 0) throw new CsvError(`line ${line} has a member without a vote`)
          const id = row[0].trim()
          const parts: string[] = []
          for (let i = 1; i < row.length; i += 2) {
            const member = row[i].trim()
            const vote = row[i + 1].trim()
            if (!member || !VOTE_CODES.has(vote)) throw new CsvError(`line ${line} has a vote "${vote}" for "${member}"`)
            parts.push(`${member}${vote}`)
          }
          const targets = this.refs.get(id)
          if (!targets) return
          const votes = parts.join(',')
          for (const rec of targets) rec.votes[id] = votes
          this.count('votes')
        }), () => this.refs.clear())
      case 'sponsors':
        return this.fold(file, () => forEachCsvRecord(text, s => {
          const rec = records.get(lisBillNumber(s.BILL_NUMBER))
          if (!rec) return
          rec.sponsors.push([s.MEMBER_ID, s.MEMBER_NAME, s.PATRON_TYPE])
          this.count('sponsors')
        }, COLUMNS.sponsors))
      case 'summaries':
        return this.fold(file, () => forEachCsvRecord(text, s => {
          const rec = records.get(lisBillNumber(s.SUM_BILNO))
          const plain = rec ? htmlToText(s.SUMMARY_TEXT) : ''
          if (rec && plain) rec.summaries.push([s.SUMMARY_TYPE, plain])
        }, COLUMNS.summaries))
      case 'fiscal':
        // The header is written `"HST_BILNO", "HST_REFID", "HST_URL"`; its names are trimmed.
        return this.fold(file, () => forEachCsvRecord(text, f => {
          const rec = records.get(lisBillNumber(f.HST_BILNO))
          if (!rec || !f.HST_URL) return
          this.count('fiscal')
          if (!rec.fiscal.some(x => x[1] === f.HST_URL)) rec.fiscal.push([f.HST_REFID, f.HST_URL])
        }, COLUMNS.fiscal))
      case 'committees':
        return this.fold(file, () => forEachCsvRecord(text, c => { this.committees.set(c.COM_COMNO, c.COM_NAME) }, COLUMNS.committees))
      case 'dockets':
      case 'subdockets': {
        const chamberName = (no: string) => (no.startsWith('S') ? 'Senate' : 'House')
        // A docket file was read, so a bill on no docket has an empty calendar.
        for (const rec of records.values()) rec.dockets ??= []
        return this.fold(file, () => forEachCsvRecord(text, d => {
          const committee = `${chamberName(d.Com_no)} ${this.committees.get(d.Com_no) ?? d.Com_no}`
          const rec = records.get(lisBillNumber(d.Bill_no))
          if (!rec) return
          this.count(file)
          rec.dockets!.push([lisDate(d.Doc_date),
            file === 'subdockets' ? `${committee} subcommittee ${Number(d.Sub_no)} docket` : `${committee} docket`])
        }, COLUMNS[file]))
      }
      case 'members':
        return this.fold(file, () => forEachCsvRecord(text, m => {
          if (m.MBR_MBRNO) this.members.push({ id: m.MBR_MBRNO, name: m.MBR_NAME, chamber: m.MBR_HOU === 'S' ? 'S' : 'H' })
        }, COLUMNS.members))
    }
  }

  private fold(file: LisFile, read: () => void, after?: () => void): void {
    try {
      read()
    } catch (err) {
      if (err instanceof CsvError) throw new Error(`LIS ${this.sessionCode} ${file}: ${err.message}`)
      throw err
    }
    after?.()
  }
}

export async function lisRecordHash(rec: LisRecord): Promise<string> {
  return sha256Hex(JSON.stringify(rec))
}

/** A record's history as entries. */
export function lisHistory(rec: LisRecord): LisHistoryEntry[] {
  if (!rec.history) return []
  return rec.history.split('\n').map(line => {
    const [date = '', desc = '', refid = ''] = line.split('\t')
    return [date, desc, refid]
  })
}

const yes = (v: string | undefined) => v === 'Y'

function isResolution(number: string): boolean {
  return /^(HJ|SJ|HR|SR)/.test(number)
}

/**
 * The session a history line continues a bill to, as a session code, or null
 * for a line that isn't a continuation. The LIS writes them three ways:
 * "Continued to next session in Rules" (the next regular session after the
 * line's date), "Continued pursuant to House Rule 22 to 2027 in Finance" (that
 * year's regular session), and "Continued to 2026 Sp. Sess. 1 pursuant to HJR
 * 316" (that special session, which is session code 20262).
 */
export function continuationTarget(date: string, desc: string): string | null {
  const m = /\bContinued\b.*?\bto\s+(next session|(\d{4})(?:\s+Sp\.?\s*Sess\.?\s*(\d+))?)/i.exec(desc)
  if (!m || !date) return null
  if (!m[2]) return `${Number(date.slice(0, 4)) + 1}1`
  return m[3] ? `${m[2]}${Number(m[3]) + 1}` : `${m[2]}1`
}

/**
 * How a bill's continuations touch this session. `into` is the continuation
 * that brought it into this session from an earlier one, if any (its date).
 * `out` says a line continues it on to a later session. The LIS carries a
 * continued bill's whole history into the next session's files, so the same
 * lines appear in both, and only their target tells the two apart.
 */
export function lisCarry(rec: LisRecord, sessionCode: string): { into: { date: string } | null; out: boolean } {
  let into: { date: string } | null = null
  let out = false
  for (const [date, desc] of lisHistory(rec)) {
    const target = continuationTarget(date, desc)
    if (target === sessionCode && (!into || date > into.date)) into = { date }
    else if (target && target > sessionCode) out = true
  }
  return { into, out }
}

/**
 * The history lines from this session. For a bill carried in, those dated
 * after the continuation and in the session's own year: the file isn't in
 * date order, and a statement the earlier session published after continuing
 * the bill belongs to that session's files. Otherwise, every line.
 */
function thisSessionHistory(rec: LisRecord, sessionCode: string): LisHistoryEntry[] {
  const { into } = lisCarry(rec, sessionCode)
  const history = lisHistory(rec)
  if (!into) return history
  const year = sessionCode.slice(0, 4)
  return history.filter(([date]) => date > into.date && date.slice(0, 4) >= year)
}

/**
 * The sessions a carried-over bill may have come from, most likely first.
 * The LIS numbers a year's sessions 1 (regular) and 2 onward (special), and a
 * bill can be continued from either into either (the 2026 budget went from
 * the regular session to Special Session I). In order:
 * 1. an earlier session of that year the bill's own history continued it
 *    into, latest first (a bill continued twice came from the second);
 * 2. that year's regular session, where continuations usually start;
 * 3. its other special sessions, latest first.
 * A special session may number its bills from 1 again, so its bills come
 * after the regular session's unless the history names it. The caller links
 * the bill to the first of these central already holds.
 */
export function lisCarriedFromCandidates(rec: LisRecord, sessionCode: string): string[] {
  const { into } = lisCarry(rec, sessionCode)
  if (!into) return []
  const year = into.date.slice(0, 4)
  const earlier = (code: string) => code.startsWith(year) && code < sessionCode
  const named = lisHistory(rec)
    .map(([date, desc]) => continuationTarget(date, desc))
    .filter((code): code is string => !!code && earlier(code))
    .sort().reverse()
  const specials = [9, 8, 7, 6, 5, 4, 3, 2].map(n => `${year}${n}`).filter(earlier)
  const codes = [...new Set([...named, `${year}1`, ...specials])].filter(earlier)
  return codes.map(code => lisNativeKey(code, rec.bill.Bill_id))
}

/** The code a LIS bill stores in `bills.status` (labeled in vocabulary.ts). */
export function lisStatus(rec: LisRecord, sessionCode: string): number {
  const b = rec.bill
  if (b.Chapter_id) return yes(b.Approved) ? LIS_STATUS.approved : LIS_STATUS.enacted
  if (yes(b.Approved)) return LIS_STATUS.approved
  if (yes(b.Vetoed)) return LIS_STATUS.vetoed
  if (yes(b.Passed) && isResolution(b.Bill_id)) return LIS_STATUS.agreedTo
  // The flag stays set on a bill carried into a later session, where it is
  // pending again, so the history says which way it went.
  const carry = lisCarry(rec, sessionCode)
  if (carry.out || (yes(b.Carried_over) && !carry.into)) return LIS_STATUS.continuedToNextSession
  // The LIS copies a carried-in bill's flags from the session it came from, so
  // until the bill moves in this session, Failed and Passed_* describe the old
  // one (HB 1238 of 2027 arrives Failed: defeated in a 2026 committee, then
  // continued).
  if (carry.into && thisSessionHistory(rec, sessionCode).length === 0) return LIS_STATUS.continuedFromLastSession
  if (yes(b.Failed)) return LIS_STATUS.failed
  if (yes(b.Passed)) return LIS_STATUS.passedGeneralAssembly
  const origin = b.Bill_id.startsWith('S') ? 'S' : 'H'
  // Passed by the second chamber is the later step; name that one.
  if (yes(b.Passed_house) && yes(b.Passed_senate)) return origin === 'H' ? LIS_STATUS.passedSenate : LIS_STATUS.passedHouse
  if (yes(b.Passed_house)) return LIS_STATUS.passedHouse
  if (yes(b.Passed_senate)) return LIS_STATUS.passedSenate
  if (carry.into) return LIS_STATUS.continuedFromLastSession
  if (thisSessionHistory(rec, sessionCode).some(([, desc]) => REFERRAL.test(splitAction(desc).action))) return LIS_STATUS.inCommittee
  return LIS_STATUS.introduced
}

/**
 * A history line that sends the bill to a committee: the first referral
 * ("Referred to Committee on Finance"), a re-referral ("Rereferred to
 * Appropriations", written after a committee reports a bill on to another),
 * a recommittal after a floor motion ("Recommitted to Education and Health"),
 * and the plain "Referred to Rules". Any of them may name the committee in
 * full ("Rereferred to Committee for Courts of Justice"), which is dropped so
 * the name matches the committee's. The lines that say where a bill came
 * from too ("Reported from Labor and Commerce and referred to Appropriations",
 * "Rereferred from X to Y") are each followed by a line of one of these, so
 * they aren't read as referrals of their own.
 */
const REFERRAL = /^(?:Referred to|Rereferred to|Recommitted to) (?:Committee (?:on|for) )?(.+)$/i

/**
 * A history line that takes the bill out of the committee it was in: the
 * committee reported it, or its work on the bill ended there.
 */
const LEAVES_COMMITTEE = /^(?:Reported from|Failed to report|Passed by indefinitely|Stricken|Left in|Continued|Tabled|Incorporated|Discharged)\b/i

/** "H Read third time and passed House (64-Y 34-N 0-A)" → { chamber: 'H', action: "Read third time ..." }. */
function splitAction(desc: string): { chamber: string; action: string } {
  const m = /^([HS])\s+(.*)$/.exec(desc.trim())
  return m ? { chamber: m[1], action: m[2] } : { chamber: '', action: desc.trim() }
}

function lastHistory(rec: LisRecord) {
  const history = lisHistory(rec)
  for (let i = history.length - 1; i >= 0; i--) {
    const [date, desc] = history[i]
    if (date && desc.trim()) return { date, ...splitAction(desc) }
  }
  return null
}

export function lisBillUrl(sessionCode: string, number: string): string {
  return `https://lis.virginia.gov/bill-details/${sessionCode}/${lisBillNumber(number)}`
}

/** The extra that holds each earlier summary, by the summary's type in Summaries.csv. */
const SUMMARY_EXTRAS: Record<string, string> = {
  'SUMMARY AS INTRODUCED': 'summaryIntroduced',
  'SUMMARY AS PASSED HOUSE': 'summaryPassedHouse',
  'SUMMARY AS PASSED SENATE': 'summaryPassedSenate',
  'SUMMARY AS PASSED': 'summaryPassed',
}

/**
 * The bill's latest summary: the one for the furthest step it reached. A
 * bill passes its own chamber before the other, so of the two chamber
 * summaries, the other chamber's is later. A type the LIS adds later (as it
 * did "as enacted with Governor's recommendation") counts as the latest.
 */
function latestSummary(rec: LisRecord): [string, string] | null {
  const second = rec.bill.Bill_id.startsWith('S') ? 'SUMMARY AS PASSED HOUSE' : 'SUMMARY AS PASSED SENATE'
  const rank = (type: string) => {
    if (type === 'SUMMARY AS INTRODUCED') return 0
    if (type === 'SUMMARY AS PASSED HOUSE' || type === 'SUMMARY AS PASSED SENATE') return type === second ? 2 : 1
    if (type === 'SUMMARY AS PASSED') return 3
    return 4
  }
  let latest: [string, string] | null = null
  for (const s of rec.summaries) if (!latest || rank(s[0]) >= rank(latest[0])) latest = s
  return latest
}

function description(rec: LisRecord): string {
  return latestSummary(rec)?.[1] || rec.bill.Bill_description
}

/** The extras (vocabulary.ts) for one record: the chapter, the emergency flag when set, and every summary but the latest. */
export function lisExtras(rec: LisRecord, sessionYear: number): NonNullable<CentralMeasure['extras']> {
  const extras: Record<string, string> = {}
  const chapter = /^CHAP0*(\d+)$/i.exec(rec.bill.Chapter_id.trim())
  if (chapter) extras.chapter = `Chapter ${chapter[1]} of the ${sessionYear} Acts of Assembly`
  if (yes(rec.bill.Emergency)) extras.emergency = 'Yes'
  const latest = latestSummary(rec)
  for (const s of rec.summaries) {
    const key = SUMMARY_EXTRAS[s[0]]
    if (key && s !== latest) extras[key] = s[1]
  }
  return extras
}

export function toLisMasterListEntry(rec: LisRecord, sessionCode: string, billId: number, hash: string): SyncEntry {
  const last = lastHistory(rec)
  return {
    bill_id: billId,
    number: rec.bill.Bill_id,
    change_hash: hash,
    title: rec.bill.Bill_description || rec.bill.Bill_id,
    description: description(rec),
    status: lisStatus(rec, sessionCode),
    status_date: last?.date,
    last_action: last?.action,
    last_action_date: last?.date,
    state_link: lisBillUrl(sessionCode, rec.bill.Bill_id),
    bill_type: billType(rec.bill.Bill_id).type,
  }
}

/**
 * A committee's native key in central's id table: its chamber and its name,
 * with case and spacing folded. Both chambers have committees of the same
 * name (each has a Rules committee, and both a Finance committee of a kind),
 * and they're different committees.
 */
export function lisCommitteeKey(chamber: string, name: string): string {
  return `${chamber}/${name.trim().replace(/\s+/g, ' ').toLowerCase()}`
}

/** The keys of the committees a record's history refers it to (lisCommitteeKey). */
export function lisCommitteeKeys(rec: LisRecord): string[] {
  return referrals(rec).map(r => lisCommitteeKey(r.chamber, r.name))
}

function referrals(rec: LisRecord): { date: string; chamber: string; name: string }[] {
  const out = []
  for (const [date, desc] of lisHistory(rec)) {
    if (!date) continue
    const { chamber, action } = splitAction(desc)
    const m = REFERRAL.exec(action)
    if (m) out.push({ date, chamber, name: m[1].trim() })
  }
  return out
}

/**
 * The committee a bill waits in, like the pending committee of another
 * provider: the one its latest referral names, until a later history line
 * reports the bill out or ends it there (LEAVES_COMMITTEE), and only while the
 * bill is still alive. A bill that has failed, been continued, or passed both
 * chambers waits in no committee. One that passed its own chamber and was
 * referred in the other waits in that chamber's committee.
 *
 * History is read in date order, and a referral stays ahead of the line that
 * reported the bill on to it ("Reported from Finance and rereferred to
 * Appropriations" comes first, then "Rereferred to Appropriations", both
 * dated that day), since the file's order within a day is kept.
 */
function pendingCommittee(rec: LisRecord, status: number): { chamber: string; name: string } | null {
  if (status !== LIS_STATUS.inCommittee && status !== LIS_STATUS.passedHouse && status !== LIS_STATUS.passedSenate) return null
  let pending: { chamber: string; name: string } | null = null
  const dated = lisHistory(rec).filter(([date]) => date).sort((a, b) => a[0].localeCompare(b[0]))
  for (const [, desc] of dated) {
    const { chamber, action } = splitAction(desc)
    const m = REFERRAL.exec(action)
    if (m) pending = { chamber, name: m[1].trim() }
    else if (LEAVES_COMMITTEE.test(action)) pending = null
  }
  return pending
}

/**
 * The key a roll call has in central's id table. A vote's reference id names
 * the vote, not the bill: one block vote carries many bills, each with its
 * own copy of the vote's member rows, so the id is the bill's too. Otherwise
 * every bill on the vote would write the same central roll call, and the last
 * would take it from the rest.
 */
export function lisRollCallKey(sessionCode: string, billNumber: string, refid: string): string {
  return `${sessionCode}/${billNumber}/${refid}`
}

/**
 * Whether a vote's member rows record anyone's vote. A voice vote has no
 * tally: the files list every member as X, "not voting", and the history line
 * says "(Voice Vote)" in place of a count. That is no roll call, and the
 * history line already says the item was taken.
 */
export function lisVoteHasTally(votes: string): boolean {
  return parseVotes(votes).some(([, v]) => v !== 'X')
}

export interface LisIds {
  /** Central person id by LIS member id ("H0173"). */
  person(memberId: string): number
  /** Central roll call id by history reference id, for the bill being built (see lisRollCallKey). */
  rollCall(refid: string): number
  /** Central supplement id by fiscal impact statement URL, and text id by `lisTextDocKey`. */
  doc(url: string): number
  /** Central committee id by lisCommitteeKey. */
  committee(key: string): number
  /** Central bill id of the bill this one was continued from, when central holds it. */
  carriedFrom?: number
}

export interface LisSession { session_id: number; session_name: string; year_start: number; year_end: number }

const MAJOR = /passed|reported|failed|defeated|continued|approved|vetoed|signed by governor|chapter|agreed to|incorporated|stricken|tabled/i
/** LegiScan and LIMS use 1 to 4 (Yea, Nay, Not Voting, Absent), so Abstain, which they have no id for, takes 5. */
const VOTE_ID: Record<string, number> = { Y: 1, N: 2, X: 3, A: 5 }

function billType(number: string): { type: string; typeId: string } {
  if (/^(HJ|SJ)/.test(number)) return { type: 'JR', typeId: '3' }
  if (/^(HR|SR)/.test(number)) return { type: 'R', typeId: '2' }
  return { type: 'B', typeId: '1' }
}

export async function buildLisBill(
  rec: LisRecord, sessionCode: string, billId: number, hash: string, session: LisSession, ids: LisIds,
  /** The PDF link of each text version of the record that has one, by LIS text id. A version with none is left out. */
  pdfs: ReadonlyMap<number, string> = new Map(),
): Promise<CentralMeasure> {
  const number = rec.bill.Bill_id
  const origin = number.startsWith('S') ? 'S' : 'H'
  const last = lastHistory(rec)
  const status = lisStatus(rec, sessionCode)
  const type = billType(number)

  const entries = lisHistory(rec)
  const history: CentralMeasure['history'] = entries
    .filter(([date, desc]) => date && desc.trim())
    .map(([date, desc]) => {
      const { chamber, action } = splitAction(desc)
      return { date, action, chamber, chamber_id: 0, importance: MAJOR.test(action) ? 1 : 2 }
    })

  const referralList: CentralMeasure['referrals'] = referrals(rec).map(r => ({
    date: r.date, committee_id: ids.committee(lisCommitteeKey(r.chamber, r.name)), chamber: r.chamber, chamber_id: 0, name: r.name,
  }))

  const pending = pendingCommittee(rec, status)
  const pendingId = pending ? ids.committee(lisCommitteeKey(pending.chamber, pending.name)) : 0

  const sponsors: CentralMeasure['sponsors'] = rec.sponsors.map(([memberId, name, type], i) => {
    const order = Number.parseInt(type, 10) || i + 1
    return {
      people_id: ids.person(memberId), name: name.trim(), party: '',
      role: memberId.startsWith('S') ? 'Senator' : 'Delegate', role_id: memberId.startsWith('S') ? 2 : 1, district: '',
      sponsor_type_id: /Chief Patron/i.test(type) ? 1 : 2, sponsor_order: order,
    }
  }).sort((a, b) => a.sponsor_order - b.sponsor_order)

  // A roll call is a counted vote. One with no tally (lisVoteHasTally) is a
  // voice vote, which the history line already records, so it is left out
  // rather than shown as a 0-0 vote that failed.
  const votes: CentralMeasure['votes'] = []
  for (const [date, desc, refid] of entries) {
    const members = refid && rec.votes[refid] && lisVoteHasTally(rec.votes[refid]) ? parseVotes(rec.votes[refid]) : []
    if (members.length === 0 || votes.some(v => v.roll_call_id === ids.rollCall(refid))) continue
    const { chamber, action } = splitAction(desc)
    const count = (code: string) => members.filter(([, v]) => v === code).length
    const yea = count('Y'), nay = count('N')
    votes.push({
      roll_call_id: ids.rollCall(refid), date, desc: action,
      // The roll_calls row has no abstain column, so this Not Voting number includes abstentions (X plus A),
      // while the member list below shows Abstain as its own group by vote_text.
      yea, nay, nv: count('X') + count('A'), absent: 0, total: members.length,
      passed: yea > nay ? 1 : 0, chamber, chamber_id: 0, url: '', state_link: lisBillUrl(sessionCode, number),
      member_votes: members.map(([memberId, v]) => ({
        people_id: ids.person(memberId), vote_id: VOTE_ID[v] ?? 3,
        vote_text: v === 'Y' ? 'Yea' : v === 'N' ? 'Nay' : v === 'A' ? 'Abstain' : 'Not Voting',
      })),
    })
  }

  const firstDateFor = (refid: string) => entries.find(h => h[2] === refid)?.[0]
  const supplements: CentralMeasure['supplements'] = rec.fiscal.map(([refid, url]) => ({
    supplement_id: ids.doc(url), date: firstDateFor(refid) || lisDate(rec.bill.Introduction_date) || `${session.year_start}-01-01`,
    type_id: 1, type: 'Fiscal Note', title: 'Fiscal Impact Statement', description: '',
    mime: 'application/pdf', url: '', state_link: url, supplement_size: 0, supplement_hash: '',
  }))

  // Left out when the pass read no docket file: no evidence, rather than an empty calendar.
  const calendar: CentralMeasure['calendar'] = rec.dockets ? [] : undefined
  for (const [date, desc] of rec.dockets ?? []) {
    if (!calendar) break
    if (!date || calendar.some(c => c.date === date && c.description === desc)) continue
    calendar.push({
      type_id: 1, type: 'Hearing', date, time: '', location: '', description: desc,
      event_hash: (await sha256Hex(`1|${date}|${desc}`)).slice(0, 32),
    })
  }

  const texts: CentralMeasure['texts'] = []
  for (const [textId, code, version, , date] of rec.texts ?? []) {
    const link = pdfs.get(textId)
    if (!link) continue
    texts.push({
      doc_id: ids.doc(lisTextDocKey(textId)), date, type: version, type_id: TEXT_TYPE_IDS[version] ?? 1,
      mime: 'application/pdf', mime_id: 2, url: '', state_link: link,
      text_size: 0, text_hash: await lisTextHash(sessionCode, code, textId),
      alt_bill_text: 0, alt_mime: '', alt_mime_id: 0, alt_state_link: '', alt_text_size: 0, alt_text_hash: '',
    })
  }

  const sasts: CentralMeasure['sasts'] = ids.carriedFrom
    ? [{ type_id: 4, type: 'Carry Over', sast_bill_number: number, sast_bill_id: ids.carriedFrom }]
    : []

  return {
    bill_id: billId,
    bill_number: number,
    title: rec.bill.Bill_description || number,
    description: description(rec),
    state: LIS_STATE,
    state_id: VA_STATE_ID,
    change_hash: hash,
    status,
    status_date: last?.date ?? '',
    bill_type: type.type,
    bill_type_id: type.typeId,
    body: origin,
    body_id: 0,
    current_body: last?.chamber || origin,
    current_body_id: 0,
    url: '',
    state_link: lisBillUrl(sessionCode, number),
    pending_committee_id: pendingId,
    session_id: session.session_id,
    session,
    committee: pending ? { committee_id: pendingId, chamber: pending.chamber, chamber_id: 0, name: pending.name } : null,
    referrals: referralList,
    progress: [],
    sponsors,
    history,
    sasts,
    subjects: [],
    votes,
    // Text comes from the LIS API when the deployment has a key (a version with no PDF link here is left out).
    // The latest summary is the description either way.
    texts,
    calendar,
    amendments: [],
    supplements,
    extras: lisExtras(rec, session.year_start),
  }
}

/** "H0056N,H0108Y" → [["H0056", "N"], ["H0108", "Y"]]. */
export function parseVotes(s: string): [string, string][] {
  return s.split(',').filter(Boolean).map(p => [p.slice(0, -1), p.slice(-1)])
}
