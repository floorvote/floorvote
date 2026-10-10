import { htmlToText, sha256Hex, type CentralMeasure, type SyncEntry } from '../sdk'
import type { LisFiles } from './client'
import { forEachCsvRecord, forEachCsvRow } from './csv'

/**
 * Mapping from Virginia's LIS data files (client.ts) to the LegiScan shapes
 * the central pipeline ingests. No I/O: ids come in through `LisIds`.
 *
 * A session's files are joined into one record per bill (assembleLisRecords):
 * the BILLS row, its full history, patrons, latest summary, fiscal impact
 * statements, per-member votes, and committee docket placements. The record is
 * stored whole, so the ingestor builds a bill with no further calls.
 *
 * Bill text is not in the files (it needs the LIS API), so the latest summary
 * stands in as the bill's description.
 */

export const LIS_STATE = 'VA'
/** LegiScan's state_id for Virginia, so LIS rows look like VA rows everywhere. */
export const VA_STATE_ID = 46

export const LIS_STATUS_LABELS: Record<number, string> = {
  1: 'Introduced',
  2: 'Passed the House',
  3: 'Passed the Senate',
  4: 'Passed the General Assembly',
  5: 'Approved by the Governor',
  6: 'Enacted',
  7: 'Vetoed by the Governor',
  8: 'Agreed to',
  9: 'Continued to next session',
  10: 'Failed',
  11: 'Continued from last session',
}

/** One bill's slice of a session's files. */
export interface LisRecord {
  /** The BILLS.CSV row, keyed by its header. */
  bill: Record<string, string>
  /** [YYYY-MM-DD, description, reference id], in the file's order. */
  history: [string, string, string][]
  /** [member id, name, patron type ("1 - Chief Patron")]. */
  sponsors: [string, string, string][]
  /** The latest summary, as plain text. */
  summary: { type: string; text: string } | null
  /** [reference id, PDF URL] for each fiscal impact statement. */
  fiscal: [string, string][]
  /**
   * Per-member votes by history reference id, as "H0056N,H0108Y,...": each
   * member id followed by its vote (Y, N, X not voting, A abstain). A string
   * rather than pairs keeps a session's records small enough to assemble in a
   * Worker (11,000 votes of up to 100 members each).
   */
  votes: Record<string, string>
  /** [YYYY-MM-DD, docket description] for each committee or subcommittee docket. */
  dockets: [string, string][]
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

/** The bill's key in source_ids and source_records: "20261/HB1". */
export function lisNativeKey(sessionCode: string, billNumber: string): string {
  return `${sessionCode}/${lisBillNumber(billNumber)}`
}

const SUMMARY_ORDER = ['SUMMARY AS INTRODUCED', 'SUMMARY AS PASSED HOUSE', 'SUMMARY AS PASSED SENATE', 'SUMMARY AS PASSED']

/** The order files are folded in: votes attach to history entries, so history comes first. */
export const LIS_FILE_ORDER = ['bills', 'history', 'votes', 'sponsors', 'summaries', 'fiscal', 'committees', 'dockets', 'subdockets', 'members'] as const

/**
 * Joins one session's files into a record per bill, plus the session's
 * members, one file at a time: a caller fetches each file, adds it, and lets
 * its text go before fetching the next.
 */
export class LisAssembler {
  private records = new Map<string, LisRecord>()
  private refs = new Map<string, LisRecord[]>()
  private committees = new Map<string, string>()
  private members: LisMember[] = []

  constructor(billsCsv: string) {
    forEachCsvRecord(billsCsv, b => {
      const id = lisBillNumber(b.Bill_id)
      if (id) this.records.set(id, { bill: { ...b, Bill_id: id }, history: [], sponsors: [], summary: null, fiscal: [], votes: {}, dockets: [] })
    })
  }

  result(): { records: Map<string, LisRecord>; members: LisMember[] } {
    return { records: this.records, members: this.members }
  }

  add(file: Exclude<keyof LisFiles, 'bills'>, text: string): void {
    if (!text) return
    const records = this.records
    switch (file) {
      case 'history':
        forEachCsvRecord(text, h => {
          const rec = records.get(lisBillNumber(h.Bill_id))
          if (!rec) return
          rec.history.push([lisDate(h.History_date), h.History_description, h.History_refid])
          if (!h.History_refid) return
          const list = this.refs.get(h.History_refid)
          if (list) list.push(rec)
          else this.refs.set(h.History_refid, [rec])
        })
        return
      case 'votes':
        // Wide rows: a vote id, then member id and vote pairs. The first line is a count.
        forEachCsvRow(text, row => {
          const id = row[0]?.trim()
          const targets = id && row.length >= 3 ? this.refs.get(id) : undefined
          if (!targets) return
          const parts: string[] = []
          for (let i = 1; i + 1 < row.length; i += 2) {
            const member = row[i].trim()
            if (member) parts.push(`${member}${row[i + 1].trim()}`)
          }
          const votes = parts.join(',')
          for (const rec of targets) rec.votes[id] = votes
        })
        return
      case 'sponsors':
        forEachCsvRecord(text, s => {
          records.get(lisBillNumber(s.BILL_NUMBER))?.sponsors.push([s.MEMBER_ID, s.MEMBER_NAME, s.PATRON_TYPE])
        })
        return
      case 'summaries': {
        const rank = (t: string) => { const i = SUMMARY_ORDER.indexOf(t); return i < 0 ? SUMMARY_ORDER.length : i }
        forEachCsvRecord(text, s => {
          const rec = records.get(lisBillNumber(s.SUM_BILNO))
          if (rec && (!rec.summary || rank(s.SUMMARY_TYPE) >= rank(rec.summary.type))) {
            rec.summary = { type: s.SUMMARY_TYPE, text: htmlToText(s.SUMMARY_TEXT).replace(/\s+/g, ' ').trim() }
          }
        })
        return
      }
      case 'fiscal': {
        // The header is written `"HST_BILNO", "HST_REFID", "HST_URL"`, so read by position.
        let header = true
        forEachCsvRow(text, ([bill, ref, url]) => {
          if (header) { header = false; return }
          const rec = records.get(lisBillNumber(bill ?? ''))
          const link = url?.trim()
          if (rec && link && !rec.fiscal.some(f => f[1] === link)) rec.fiscal.push([(ref ?? '').trim(), link])
        })
        return
      }
      case 'committees':
        forEachCsvRecord(text, c => { this.committees.set(c.COM_COMNO, c.COM_NAME) })
        return
      case 'dockets':
      case 'subdockets': {
        const chamberName = (no: string) => (no.startsWith('S') ? 'Senate' : 'House')
        forEachCsvRecord(text, d => {
          const committee = `${chamberName(d.Com_no)} ${this.committees.get(d.Com_no) ?? d.Com_no}`
          records.get(lisBillNumber(d.Bill_no))?.dockets.push([lisDate(d.Doc_date),
            file === 'subdockets' ? `${committee} subcommittee ${Number(d.Sub_no)} docket` : `${committee} docket`])
        })
        return
      }
      case 'members':
        forEachCsvRecord(text, m => {
          if (m.MBR_MBRNO) this.members.push({ id: m.MBR_MBRNO, name: m.MBR_NAME, chamber: m.MBR_HOU === 'S' ? 'S' : 'H' })
        })
        return
    }
  }
}

export async function lisRecordHash(rec: LisRecord): Promise<string> {
  return sha256Hex(JSON.stringify(rec))
}

const yes = (v: string | undefined) => v === 'Y'

function isResolution(number: string): boolean {
  return /^(HJ|SJ|HR|SR)/.test(number)
}

export function lisStatus(rec: LisRecord, sessionYear: number): number {
  const b = rec.bill
  if (b.Chapter_id) return yes(b.Approved) ? 5 : 6
  if (yes(b.Approved)) return 5
  if (yes(b.Vetoed)) return 7
  if (yes(b.Passed) && isResolution(b.Bill_id)) return 8
  // The flag stays set on a bill carried into the next session; there it is pending again.
  if (yes(b.Carried_over)) return lisCarriedOver(rec, sessionYear) ? 11 : 9
  if (yes(b.Failed)) return 10
  if (yes(b.Passed)) return 4
  const origin = b.Bill_id.startsWith('S') ? 'S' : 'H'
  // Passed by the second chamber is the later step; name that one.
  if (yes(b.Passed_house) && yes(b.Passed_senate)) return origin === 'H' ? 3 : 2
  if (yes(b.Passed_house)) return 2
  if (yes(b.Passed_senate)) return 3
  return 1
}

/** "H Read third time and passed House (64-Y 34-N 0-A)" → { chamber: 'H', action: "Read third time ..." }. */
function splitAction(desc: string): { chamber: string; action: string } {
  const m = /^([HS])\s+(.*)$/.exec(desc.trim())
  return m ? { chamber: m[1], action: m[2] } : { chamber: '', action: desc.trim() }
}

function lastHistory(rec: LisRecord) {
  for (let i = rec.history.length - 1; i >= 0; i--) {
    const [date, desc] = rec.history[i]
    if (date && desc.trim()) return { date, ...splitAction(desc) }
  }
  return null
}

export function lisBillUrl(sessionCode: string, number: string): string {
  return `https://lis.virginia.gov/bill-details/${sessionCode}/${lisBillNumber(number)}`
}

function description(rec: LisRecord): string {
  return rec.summary?.text || rec.bill.Bill_description
}

export function toLisMasterListEntry(rec: LisRecord, sessionCode: string, billId: number, hash: string): SyncEntry {
  const last = lastHistory(rec)
  return {
    bill_id: billId,
    number: rec.bill.Bill_id,
    change_hash: hash,
    title: rec.bill.Bill_description || rec.bill.Bill_id,
    description: description(rec),
    status: lisStatus(rec, Number(sessionCode.slice(0, 4))),
    status_date: last?.date,
    last_action: last?.action,
    last_action_date: last?.date,
    state_link: lisBillUrl(sessionCode, rec.bill.Bill_id),
  }
}

export interface LisIds {
  /** Central person id by LIS member id ("H0173"). */
  person(memberId: string): number
  /** Central roll call id by history reference id. */
  rollCall(refid: string): number
  /** Central supplement id by fiscal impact statement URL. */
  doc(url: string): number
  /** Central bill id of the same bill number in the previous regular session, for a carried-over bill. */
  carriedFrom?: number
}

export interface LisSession { session_id: number; session_name: string; year_start: number; year_end: number }

const MAJOR = /passed|reported|failed|defeated|continued|approved|vetoed|signed by governor|chapter|agreed to|incorporated|stricken|tabled/i
const VOTE_ID: Record<string, number> = { Y: 1, N: 2, X: 3, A: 3 }

function billType(number: string): { type: string; typeId: string } {
  if (/^(HJ|SJ)/.test(number)) return { type: 'JR', typeId: '3' }
  if (/^(HR|SR)/.test(number)) return { type: 'R', typeId: '2' }
  return { type: 'B', typeId: '1' }
}

export async function buildLisBill(
  rec: LisRecord, sessionCode: string, billId: number, hash: string, session: LisSession, ids: LisIds,
): Promise<CentralMeasure> {
  const number = rec.bill.Bill_id
  const origin = number.startsWith('S') ? 'S' : 'H'
  const last = lastHistory(rec)
  const status = lisStatus(rec, Number(sessionCode.slice(0, 4)))
  const type = billType(number)

  const history: CentralMeasure['history'] = rec.history
    .filter(([date, desc]) => date && desc.trim())
    .map(([date, desc]) => {
      const { chamber, action } = splitAction(desc)
      return { date, action, chamber, chamber_id: 0, importance: MAJOR.test(action) ? 1 : 2 }
    })

  const referrals: CentralMeasure['referrals'] = []
  for (const h of history) {
    const m = /^Referred to Committee (?:on|for) (.+)$/i.exec(h.action)
    if (m) referrals.push({ date: h.date, committee_id: 0, chamber: h.chamber, chamber_id: 0, name: m[1].trim() })
  }

  const sponsors: CentralMeasure['sponsors'] = rec.sponsors.map(([memberId, name, type], i) => {
    const order = Number.parseInt(type, 10) || i + 1
    return {
      people_id: ids.person(memberId), name: name.trim(), party: '',
      role: memberId.startsWith('S') ? 'Senator' : 'Delegate', role_id: memberId.startsWith('S') ? 2 : 1, district: '',
      sponsor_type_id: /Chief Patron/i.test(type) ? 1 : 2, sponsor_order: order,
    }
  }).sort((a, b) => a.sponsor_order - b.sponsor_order)

  const votes: CentralMeasure['votes'] = []
  for (const [date, desc, refid] of rec.history) {
    const members = refid && rec.votes[refid] ? parseVotes(rec.votes[refid]) : []
    if (members.length === 0 || votes.some(v => v.roll_call_id === ids.rollCall(refid))) continue
    const { chamber, action } = splitAction(desc)
    const count = (code: string) => members.filter(([, v]) => v === code).length
    const yea = count('Y'), nay = count('N')
    votes.push({
      roll_call_id: ids.rollCall(refid), date, desc: action,
      yea, nay, nv: count('X') + count('A'), absent: 0, total: members.length,
      passed: yea > nay ? 1 : 0, chamber, chamber_id: 0, url: '', state_link: lisBillUrl(sessionCode, number),
      member_votes: members.map(([memberId, v]) => ({
        people_id: ids.person(memberId), vote_id: VOTE_ID[v] ?? 3,
        vote_text: v === 'Y' ? 'Yea' : v === 'N' ? 'Nay' : v === 'A' ? 'Abstain' : 'Not Voting',
      })),
    })
  }

  const firstDateFor = (refid: string) => rec.history.find(h => h[2] === refid)?.[0]
  const supplements: CentralMeasure['supplements'] = rec.fiscal.map(([refid, url]) => ({
    supplement_id: ids.doc(url), date: firstDateFor(refid) || lisDate(rec.bill.Introduction_date) || `${session.year_start}-01-01`,
    type_id: 1, type: 'Fiscal Note', title: 'Fiscal Impact Statement', description: '',
    mime: 'application/pdf', url: '', state_link: url, supplement_size: 0, supplement_hash: '',
  }))

  const calendar: CentralMeasure['calendar'] = []
  for (const [date, desc] of rec.dockets) {
    if (!date || calendar.some(c => c.date === date && c.description === desc)) continue
    calendar.push({
      type_id: 1, type: 'Hearing', date, time: '', location: '', description: desc,
      event_hash: (await sha256Hex(`1|${date}|${desc}`)).slice(0, 32),
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
    pending_committee_id: 0,
    session_id: session.session_id,
    session,
    committee: null,
    referrals,
    progress: [],
    sponsors,
    history,
    sasts,
    subjects: [],
    votes,
    // Text needs the LIS API (a registered key); the summary stands in as the description.
    texts: [],
    calendar,
    amendments: [],
    supplements,
  }
}

/** "H0056N,H0108Y" → [["H0056", "N"], ["H0108", "Y"]]. */
export function parseVotes(s: string): [string, string][] {
  return s.split(',').filter(Boolean).map(p => [p.slice(0, -1), p.slice(-1)])
}

/**
 * Whether a bill was continued into this session from the previous one: its
 * history, which the LIS carries over with it, says it was continued in an
 * earlier year. (Any bill prefiled in November or December has history from
 * an earlier year, so dates alone do not tell.)
 */
export function lisCarriedOver(rec: LisRecord, sessionYear: number): boolean {
  return rec.history.some(([date, desc]) =>
    date && Number(date.slice(0, 4)) < sessionYear && /^[HS]?\s*Continued\b.*\bto (next session|\d{4})/i.test(desc))
}
