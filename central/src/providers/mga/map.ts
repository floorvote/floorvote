import { sha256Hex, type CentralMeasure, type SyncEntry } from '../sdk'
import { MGA_BASE, type MgaRecord } from './client'

/**
 * Pure mapping from Maryland General Assembly records (client.ts) to the
 * LegiScan shapes the central pipeline ingests. No I/O: ids come in through
 * `MgaIds`, allocated by the caller.
 *
 * The session file is the whole source. It has no action history, so history
 * is rebuilt from the milestone fields (first reading, committee report, second
 * and third reading, in each chamber); scheduled hearings become calendar
 * entries. Text and fiscal-note PDFs sit at paths built from the bill number.
 */

export const MGA_STATE = 'MD'
/** LegiScan's state_id for Maryland, so MGA rows look like MD rows everywhere. */
export const MD_STATE_ID = 20

/** Outcomes the Governor or the constitution decides: the file gives them no date. */
const UNDATED_OUTCOMES = new Set([6, 7, 8, 9, 10, 11])

/**
 * The code an MGA bill stores in `bills.status` (labeled in vocabulary.ts).
 * The file's own Status field is the last action as free text (over a
 * thousand distinct values a session), so the code is derived from the
 * structured fields, and the text is kept as the last action.
 */
export function mgaStatus(r: MgaRecord): number {
  const s = r.Status ?? ''
  if (/Veto Override/i.test(s)) return 8
  if (/subject to constitutional referendum/i.test(s)) return 9
  if (/Article II, Section 17\(c\)/i.test(s)) return 7
  if (/Joint Resolution \d+/i.test(s)) return 10
  if (r.ChapterNumber) return 6
  if (/^Vetoed by the Governor/i.test(s)) return 11
  // Passed, no chapter, and back on the floor: a veto override vote deferred
  // ("Special Order vote on veto until next session") or postponed for good.
  if (r.PassedByMGA && /veto|Postpone Indefinitely/i.test(s)) return 11
  if (/Withdrawn/i.test(s)) return 13
  if (/Unfavorable Report/i.test(s)) return 12
  if (/Postpone Indefinitely.*Adopted/i.test(s)) return 14
  if (r.PassedByMGA) return 5
  if (/^Passed/i.test(r.ThirdReadingActionHouseOfOrigin ?? '')) return originChamber(r) === 'H' ? 3 : 4
  if (r.FirstReadingDateHouseOfOrigin) return 2
  return 1
}

/** "HB0001" → "HB1", as LegiScan and the MGA's own pages write it. */
export function mgaDisplayNumber(billNumber: string): string {
  const m = /^([A-Z]+)0*(\d+)$/.exec(billNumber.trim())
  return m ? `${m[1]}${m[2]}` : billNumber.trim()
}

/** The bill's key in provider_ids and provider_records: "2026RS/HB0001". */
export function mgaNativeKey(sessionCode: string, billNumber: string): string {
  return `${sessionCode}/${billNumber.trim()}`
}

function originChamber(r: MgaRecord): 'H' | 'S' {
  return r.BillNumber.startsWith('S') ? 'S' : 'H'
}

function otherChamber(c: 'H' | 'S'): 'H' | 'S' {
  return c === 'H' ? 'S' : 'H'
}

const CHAMBER_NAME = { H: 'House', S: 'Senate' } as const

/** HB/SB bills, HJ/SJ joint resolutions, and HR/SR resolutions of one chamber. */
export function mgaBillType(billNumber: string): { type: string; typeId: string } {
  const prefix = /^[A-Z]+/.exec(billNumber.trim())?.[0] ?? ''
  if (prefix === 'HJ' || prefix === 'SJ') return { type: 'JR', typeId: '3' }
  if (prefix === 'HR' || prefix === 'SR') return { type: 'R', typeId: '2' }
  return { type: 'B', typeId: '1' }
}

export function mgaBillUrl(sessionCode: string, billNumber: string): string {
  return `${MGA_BASE}/mgawebsite/Legislation/Details/${billNumber.toLowerCase()}?ys=${sessionCode}`
}

/** The MGA writes the same chamber prefix ("hb", "sj") into every document path. */
function docPaths(sessionCode: string, billNumber: string) {
  const lower = billNumber.toLowerCase()
  const prefix = /^[a-z]+/.exec(lower)?.[0] ?? ''
  const seq = lower.slice(prefix.length)
  return {
    text: (version: string) => `${MGA_BASE}/${sessionCode}/bills/${prefix}/${lower}${version}.pdf`,
    fiscalNote: `${MGA_BASE}/${sessionCode}/fnotes/bil_${seq}/${lower}.pdf`,
  }
}

/** Text versions in the order the MGA prints them, up to and including the bill's current one. */
const VERSIONS = [
  { letter: 'F', type: 'First Reader', typeId: 1 },
  { letter: 'T', type: 'Third Reader', typeId: 3 },
  { letter: 'E', type: 'Enrolled', typeId: 5 },
] as const

export function mgaTextVersions(r: MgaRecord): string[] {
  const upTo = VERSIONS.findIndex(v => v.letter === r.BillVersion)
  return VERSIONS.slice(0, upTo < 0 ? 1 : upTo + 1).map(v => v.letter)
}

interface Milestone { date: string; action: string; chamber: 'H' | 'S'; importance: number }

function committees(primary: string, secondary: string): string {
  return [primary, secondary].map(c => c?.trim()).filter(Boolean).join(' and ')
}

function milestones(r: MgaRecord): Milestone[] {
  const origin = originChamber(r)
  const sides = [
    { c: origin, sfx: 'HouseOfOrigin' as const, committee: committees(r.CommitteePrimaryOrigin, r.CommitteeSecondaryOrigin) },
    { c: otherChamber(origin), sfx: 'OppositeHouse' as const, committee: committees(r.CommitteePrimaryOpposite, r.CommitteeSecondaryOpposite) },
  ]
  const out: Milestone[] = []
  for (const { c, sfx, committee } of sides) {
    const first = r[`FirstReadingDate${sfx}`]
    if (first) out.push({ date: first, chamber: c, importance: 1, action: committee ? `First Reading ${committee}` : 'First Reading' })
    const report = r[`ReportDate${sfx}`]
    const reportAction = r[`ReportAction${sfx}`]?.trim()
    if (report && reportAction) out.push({ date: report, chamber: c, importance: 2, action: committee ? `${reportAction} Report by ${committee}` : `${reportAction} Report` })
    const second = r[`SecondReadingDate${sfx}`]
    const secondAction = r[`SecondReadingAction${sfx}`]?.trim()
    if (second && secondAction) out.push({ date: second, chamber: c, importance: 2, action: `Second Reading ${secondAction}` })
    const third = r[`ThirdReadingDate${sfx}`]
    const thirdAction = r[`ThirdReadingAction${sfx}`]?.trim()
    if (third && thirdAction) out.push({ date: third, chamber: c, importance: 1, action: `Third Reading ${thirdAction}` })
  }
  return out.sort((a, b) => a.date.localeCompare(b.date))
}

function lastActionDate(r: MgaRecord, status: number, history: Milestone[]): string | undefined {
  if (UNDATED_OUTCOMES.has(status)) return undefined
  return history[history.length - 1]?.date
}

/**
 * The record's hash, the change signal. StatusCurrentAsOf is left out: it is
 * the file's timestamp, the same on every record, and moves on every
 * regeneration, so including it would mark every bill changed every pass.
 */
export async function mgaRecordHash(r: MgaRecord): Promise<string> {
  const { StatusCurrentAsOf: _asOf, ...rest } = r
  return sha256Hex(JSON.stringify(rest))
}

export function toMgaMasterListEntry(
  r: MgaRecord, sessionCode: string, billId: number, hash: string, storedDescription: string | null,
): SyncEntry {
  const status = mgaStatus(r)
  const history = milestones(r)
  return {
    bill_id: billId,
    number: mgaDisplayNumber(r.BillNumber),
    change_hash: hash,
    title: r.Title?.trim() || mgaDisplayNumber(r.BillNumber),
    description: r.Synopsis?.trim() || (storedDescription as string),
    status,
    status_date: lastActionDate(r, status, history),
    last_action: r.Status?.trim() || undefined,
    last_action_date: lastActionDate(r, status, history),
    state_link: mgaBillUrl(sessionCode, r.BillNumber),
  }
}

export interface MgaIds {
  /** Central bill id of a bill in this session, by its MGA number ("SB0002"). */
  bill(billNumber: string): number | undefined
  /** Central person id for a sponsor, by the name as written ("Delegate Crosby"). */
  person(name: string): number
  /** Central document id, by key (see mgaDocKeys). */
  doc(key: string): number
}

/** Every document key buildMgaBill asks MgaIds for. */
export function mgaDocKeys(sessionCode: string, r: MgaRecord): string[] {
  return [
    ...mgaTextVersions(r).map(v => `${sessionCode}/${r.BillNumber}${v}`),
    `${sessionCode}/${r.BillNumber}/fiscal-note`,
  ]
}

/**
 * Every sponsor on a record, primary first, without repeats. The primary
 * sponsor may be a committee chair, an officer or a county delegation. After
 * it, only Delegates and Senators are sponsors: a bill introduced by request
 * lists the request's parts ("Departmental", "Human Services") as names too.
 */
export function mgaSponsorNames(r: MgaRecord): string[] {
  const primary = r.SponsorPrimary?.trim()
  const others = (r.Sponsors ?? []).map(s => s.Name?.trim()).filter(n => n && /^(Delegate|Senator) /.test(n))
  return [...new Set([primary, ...others].filter((n): n is string => !!n))]
}

/** "Delegate Crosby" → { role: "Delegate", name: "Crosby" }; committee and officer sponsors keep their whole name. */
function splitSponsor(full: string): { role: string; name: string } {
  const m = /^(Delegate|Senator)\s+(.+)$/.exec(full)
  return m ? { role: m[1], name: m[2] } : { role: '', name: full }
}

export interface MgaSession { session_id: number; session_name: string; year_start: number; year_end: number }

export async function buildMgaBill(
  r: MgaRecord, sessionCode: string, billId: number, hash: string, session: MgaSession, ids: MgaIds,
): Promise<CentralMeasure> {
  const number = mgaDisplayNumber(r.BillNumber)
  const origin = originChamber(r)
  const status = mgaStatus(r)
  const history = milestones(r)
  const type = mgaBillType(r.BillNumber)
  const paths = docPaths(sessionCode, r.BillNumber)
  const yearStart = `${session.year_start}-01-01`

  // Each text is dated by the reading that produced it; the file has no print dates.
  const versionDate: Record<string, string> = {
    F: r.FirstReadingDateHouseOfOrigin ?? yearStart,
    T: r.ThirdReadingDateHouseOfOrigin ?? r.SecondReadingDateHouseOfOrigin ?? r.FirstReadingDateHouseOfOrigin ?? yearStart,
    E: r.ThirdReadingDateOppositeHouse ?? r.ThirdReadingDateHouseOfOrigin ?? yearStart,
  }
  const texts: CentralMeasure['texts'] = mgaTextVersions(r).map(letter => {
    const v = VERSIONS.find(x => x.letter === letter)!
    return {
      doc_id: ids.doc(`${sessionCode}/${r.BillNumber}${letter}`), date: versionDate[letter], type: v.type, type_id: v.typeId,
      mime: 'application/pdf', mime_id: 2, url: '', state_link: paths.text(letter),
      text_size: 0, text_hash: '',
      alt_bill_text: 0, alt_mime: '', alt_mime_id: 0, alt_state_link: '', alt_text_size: 0, alt_text_hash: '',
    }
  })

  // Every bill and joint resolution gets a fiscal and policy note.
  const supplements: CentralMeasure['supplements'] = r.FirstReadingDateHouseOfOrigin ? [{
    supplement_id: ids.doc(`${sessionCode}/${r.BillNumber}/fiscal-note`), date: r.FirstReadingDateHouseOfOrigin,
    type_id: 1, type: 'Fiscal Note', title: 'Fiscal and Policy Note', description: '',
    mime: 'application/pdf', url: '', state_link: paths.fiscalNote, supplement_size: 0, supplement_hash: '',
  }] : []

  const hearings = [
    { at: r.HearingDateTimePrimaryHouseOfOrigin, c: origin, committee: r.CommitteePrimaryOrigin },
    { at: r.HearingDateTimeSecondaryHouseOfOrigin, c: origin, committee: r.CommitteeSecondaryOrigin },
    { at: r.HearingDateTimePrimaryOppositeHouse, c: otherChamber(origin), committee: r.CommitteePrimaryOpposite },
    { at: r.HearingDateTimeSecondaryOppositeHouse, c: otherChamber(origin), committee: r.CommitteeSecondaryOpposite },
  ]
  const calendar: CentralMeasure['calendar'] = []
  for (const h of hearings) {
    if (!h.at) continue
    const date = h.at.slice(0, 10)
    const time = h.at.slice(11, 16)
    const description = `${CHAMBER_NAME[h.c]} ${h.committee?.trim() || 'committee'} hearing`
    calendar.push({
      type_id: 1, type: 'Hearing', date, time, location: '', description,
      event_hash: (await sha256Hex(`1|${date}|${time}|${description}`)).slice(0, 32),
    })
  }

  const sponsors: CentralMeasure['sponsors'] = mgaSponsorNames(r).map((full, i) => {
    const { role, name } = splitSponsor(full)
    return {
      people_id: ids.person(full), name, party: '', role, role_id: role === 'Senator' ? 2 : role === 'Delegate' ? 1 : 0,
      district: '', sponsor_type_id: i === 0 ? 1 : 2, sponsor_order: i + 1,
    }
  })

  const referrals: CentralMeasure['referrals'] = []
  const firstOrigin = r.FirstReadingDateHouseOfOrigin
  const firstOpposite = r.FirstReadingDateOppositeHouse
  for (const [date, c, names] of [
    [firstOrigin, origin, [r.CommitteePrimaryOrigin, r.CommitteeSecondaryOrigin]],
    [firstOpposite, otherChamber(origin), [r.CommitteePrimaryOpposite, r.CommitteeSecondaryOpposite]],
  ] as const) {
    if (!date) continue
    for (const name of names) {
      if (name?.trim()) referrals.push({ date, committee_id: 0, chamber: c, chamber_id: 0, name: name.trim() })
    }
  }

  const crossfile = r.CrossfileBillNumber?.trim()
  const crossfileId = crossfile ? ids.bill(crossfile) : undefined
  const sasts: CentralMeasure['sasts'] = crossfile && crossfileId
    ? [{ type_id: 1, type: 'Cross-filed', sast_bill_number: mgaDisplayNumber(crossfile), sast_bill_id: crossfileId }]
    : []

  const subjectCodes = [...(r.BroadSubjects ?? []), ...(r.NarrowSubjects ?? [])]
  const subjects: CentralMeasure['subjects'] = await Promise.all(subjectCodes.map(async s => ({
    // Subjects carry a short code, not a number; this keeps the id stable per code.
    subject_id: parseInt((await sha256Hex(`mga-subject|${s.Code}`)).slice(0, 7), 16),
    subject_name: s.Name,
  })))

  const historyOut = history.map(h => ({ date: h.date, action: h.action, chamber: h.chamber, chamber_id: 0, importance: h.importance }))

  const current = /^In the Senate/.test(r.Status ?? '') ? 'S' : /^In the House/.test(r.Status ?? '') ? 'H' : origin
  return {
    bill_id: billId,
    bill_number: number,
    title: r.Title?.trim() || number,
    description: r.Synopsis?.trim() ?? '',
    state: MGA_STATE,
    state_id: MD_STATE_ID,
    change_hash: hash,
    status,
    status_date: lastActionDate(r, status, history) ?? '',
    bill_type: type.type,
    bill_type_id: type.typeId,
    body: origin,
    body_id: 0,
    current_body: current,
    current_body_id: 0,
    url: '',
    state_link: mgaBillUrl(sessionCode, r.BillNumber),
    pending_committee_id: 0,
    session_id: session.session_id,
    session,
    committee: null,
    referrals,
    progress: [],
    sponsors,
    history: historyOut,
    sasts,
    subjects,
    votes: [],
    texts,
    calendar,
    amendments: [],
    supplements,
  }
}
