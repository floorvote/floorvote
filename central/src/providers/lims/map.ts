import { sha256Hex, type CentralMeasure, type MeasureCalendarEntry, type SyncEntry } from '../sdk'
import type { LimsBulkRecord, LimsCouncilPeriod, LimsDocument, LimsLegislationDetails, LimsMember } from './client'
import { limsDocId, limsRollCallId, limsSessionId } from './ids'
import { vocabulary } from './vocabulary'

/**
 * Pure mapping from DC Council LIMS records to the LegiScan shapes the central
 * pipeline already ingests (`SyncEntry` for the sync, `CentralMeasure` for
 * the ingestor). No I/O here; the sync and ingestor fetch, this translates.
 *
 * Source split, from comparing the two endpoints on live data:
 * - BulkData `legislationHistory` is the full legislative history (introduction,
 *   referral, hearing notices, hearings, mark-ups, readings, transmittals,
 *   signing, publication) with a download URL per step. It is the history, the
 *   calendar, and most of the documents.
 * - LegislationDetails adds what bulk lacks: sponsors, committee prints and
 *   reports, Councilmember votes (on `actions`, which list floor readings only),
 *   hearing cancellations, other documents, and the bill summary.
 */

export const LIMS_STATE = 'DC'
/** LegiScan's state_id for DC, kept so LIMS rows look like DC rows everywhere. */
export const DC_STATE_ID = 51

/**
 * `bills.status` for a LIMS measure is LIMS_STATUS_BASE plus the LIMS status
 * id. The vocabulary (vocabulary.ts) labels each code with its LIMS name.
 */
export const LIMS_STATUS_BASE = 100

const STATUS_CODE_BY_NAME = new Map(Object.entries(vocabulary.statuses).map(([code, s]) => [s.label.toLowerCase(), Number(code)]))

export function limsStatusCode(name: string | null | undefined): number {
  return STATUS_CODE_BY_NAME.get(clean(name).toLowerCase()) ?? LIMS_STATUS_BASE
}

/**
 * Status code for a measure. Earlier Council Periods leave `status` blank (every
 * CP25 bill does) or "Not Applicable", but still carry the law and act or
 * resolution numbers, so fall back to those: a law number means Official Law,
 * an act number (A25-...) Enacted, a resolution number (R25-...) Approved.
 */
export function limsMeasureStatus(
  rec: { status: string | null; lawNumber: string | null; actResNumber: string | null },
  detailsStatus?: string | null,
): number {
  const code = limsStatusCode(clean(detailsStatus) || rec.status)
  if (code !== LIMS_STATUS_BASE) return code
  if (clean(rec.lawNumber)) return limsStatusCode('Official Law')
  const actRes = clean(rec.actResNumber)
  if (/^A\d/i.test(actRes)) return limsStatusCode('Enacted')
  if (/^R\d/i.test(actRes)) return limsStatusCode('Approved')
  return code
}

// ── Small helpers ─────────────────────────────────────────────────────────────

/** Trim and collapse whitespace; LIMS text carries trailing and doubled spaces. */
export function clean(s: string | null | undefined): string {
  return (s ?? '').replace(/\s+/g, ' ').trim()
}

const MONTHS: Record<string, string> = {
  Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
  Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12',
}

/** "Oct 06, 2025" (bulk) or "2025-10-06T00:00:00" (details) → "2025-10-06". */
export function limsDate(s: string | null | undefined): string | null {
  if (!s) return null
  const iso = /^(\d{4}-\d{2}-\d{2})/.exec(s)
  if (iso) return iso[1]
  const m = /^([A-Z][a-z]{2}) (\d{1,2}), (\d{4})$/.exec(s.trim())
  if (m && MONTHS[m[1]]) return `${m[3]}-${MONTHS[m[1]]}-${m[2].padStart(2, '0')}`
  return null
}

const SUFFIX_RE = /,?\s+(Jr|Sr|II|III|IV)\.?(?=,|$)/i

/**
 * Comparable key for a Councilmember name as LIMS writes it on different
 * surfaces: "Parker, Zachary", "Zachary Parker ", "Robert C. White, Jr.",
 * "White, Robert C. Jr.". Generational suffixes are dropped, and a
 * "Last, First" name is turned around.
 */
export function personKey(name: string): string {
  const n = clean(name).replace(/^(Councilmember|Chairman|Chairperson|Chair)\s+/i, '').replace(SUFFIX_RE, '')
  const comma = n.indexOf(',')
  const full = comma >= 0 ? `${n.slice(comma + 1)} ${n.slice(0, comma)}` : n
  return full.toLowerCase().replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim()
}

/** personKey without middle names or initials: "robert c white" → "robert white". */
export function personShortKey(name: string): string {
  const parts = personKey(name).split(' ')
  return parts.length > 2 ? `${parts[0]} ${parts[parts.length - 1]}` : parts.join(' ')
}

/**
 * Index Councilmembers under both keys. A short key shared by two people is
 * left out rather than guessed.
 */
export function indexPeople(list: LimsPerson[]): Map<string, LimsPerson> {
  const map = new Map<string, LimsPerson>()
  const shortCount = new Map<string, number>()
  for (const p of list) shortCount.set(personShortKey(p.name), (shortCount.get(personShortKey(p.name)) ?? 0) + 1)
  for (const p of list) {
    map.set(personKey(p.name), p)
    const short = personShortKey(p.name)
    if (shortCount.get(short) === 1 && !map.has(short)) map.set(short, p)
  }
  return map
}

function findPerson(people: Map<string, LimsPerson>, name: string): LimsPerson | undefined {
  return people.get(personKey(name)) ?? people.get(personShortKey(name))
}

export interface LimsDocRef {
  /** The `?Id=` in the download URL: one global sequence across document types. */
  id: number
  /** Path segment naming the document type, e.g. "Introduction", "Hearing_Notice". */
  kind: string
  url: string
}

/** Parse a LIMS download URL. Returns null for URLs without an `?Id=`. */
export function parseDocUrl(url: string | null | undefined): LimsDocRef | null {
  if (!url) return null
  const id = /[?&]Id=(\d+)/.exec(url)
  if (!id) return null
  const kind = /\/LIMS\/\d+\/(?:Meeting\d+\/)?([^/]+)\//.exec(url)?.[1] ?? 'Other'
  return { id: Number(id[1]), kind, url }
}

/** LIMS documents are immutable per download Id (a new version gets a new Id). */
function docHash(id: number): Promise<string> {
  return sha256Hex(`lims-doc:${id}`)
}

/**
 * A title for a document LIMS gives none, from its file name less the measure
 * number: "B26-0400-Request_to_Agendize.pdf" is "Request to Agendize". Most
 * documents typed "Other" have only this to tell them apart.
 */
function documentTitle(doc: LimsDocument, number: string): string {
  const given = clean(doc.documentTitle)
  if (given) return given
  const file = /\/([^/?]+)\.[A-Za-z0-9]+(?:\?|$)/.exec(doc.url ?? '')?.[1] ?? ''
  let name = file
  try { name = decodeURIComponent(file) } catch { /* keep the raw name */ }
  const prefix = number.replace(/[^A-Za-z0-9]/g, c => `\\${c}`)
  return clean(name.replace(new RegExp(`^${prefix}[-_]?`, 'i'), '').replace(/_/g, ' ')) || clean(doc.documentTypeName)
}

// ── Sessions ──────────────────────────────────────────────────────────────────

/**
 * "2025-2026 Council Period 26". Tenant URLs slug it to "cp26" (sessionToSlug in
 * shared/sessionSlug.ts); the leading year span still orders sessions.
 */
export function councilPeriodName(cp: LimsCouncilPeriod): string {
  return `${cp.startDate.slice(0, 4)}-${cp.endDate.slice(0, 4)} Council Period ${cp.councilPeriodId}`
}

export function councilPeriodSession(cp: LimsCouncilPeriod) {
  return {
    session_id: limsSessionId(cp.councilPeriodId),
    session_name: councilPeriodName(cp),
    year_start: Number(cp.startDate.slice(0, 4)),
    year_end: Number(cp.endDate.slice(0, 4)),
  }
}

// ── BulkData → SyncEntry ────────────────────────────────────────────────

/**
 * Hash of the normalized bulk record. It is the bill's `change_hash`: the sync
 * compares it day to day, and the ingestor writes the same value back, so an
 * unchanged record never re-queues. History order is part of the record (some
 * bills have two entries with the same date and text).
 */
export function bulkHash(rec: LimsBulkRecord): Promise<string> {
  const norm = {
    number: clean(rec.legislationNumber),
    category: clean(rec.legislationCategory),
    sub: clean(rec.legislationSubCategory),
    title: clean(rec.title),
    introduced: clean(rec.introductionDate),
    by: clean(rec.introducedBy),
    co: clean(rec.coSponsors),
    referral: clean(rec.committeeReferral),
    act: clean(rec.actResNumber),
    law: clean(rec.lawNumber),
    projected: clean(rec.projectedLawDate),
    status: clean(rec.status),
    history: (rec.legislationHistory ?? []).map(h =>
      [clean(h.actionDate), clean(h.actionDescription), clean(h.downloadURL)]),
  }
  return sha256Hex(JSON.stringify(norm))
}

/** Oversight hearing/roundtable notices and records: the record itself is the event. */
function isOversightCategory(rec: { legislationCategory: string }): boolean {
  return /Oversight Hearing\/Roundtable/i.test(rec.legislationCategory)
}

/**
 * The change_hash a LIMS bill is stored and compared under: the bulk hash, plus
 * how many history entries are now in the past. The bulk record does not change
 * when a future-dated hearing's day arrives, but the bill's latest action does,
 * so the hash has to move with it. The sync and the ingestor both compute this
 * for the same day, so it never re-queues a bill on its own.
 */
export async function effectiveChangeHash(rec: LimsBulkRecord, bulk: string, today: string): Promise<string> {
  const dated = (rec.legislationHistory ?? []).map(h => limsDate(h.actionDate)).filter((d): d is string => !!d)
  if (!dated.some(d => d > today)) return bulk
  return sha256Hex(`${bulk}|${dated.filter(d => d <= today).length}`)
}

/** The Council's public page for a measure. */
export function limsBillUrl(number: string): string {
  return `https://lims.dccouncil.gov/Legislation/${number}`
}

/** Only notices go on the calendar; a hearing record would duplicate its notice. */
function isNoticeCategory(rec: { legislationCategory: string }): boolean {
  return /Oversight Hearing\/Roundtable Notice/i.test(rec.legislationCategory)
}

/** Latest history entry on or before `today` (future-dated hearings excluded). */
function lastAction(rec: LimsBulkRecord, today: string): { action: string; date: string } | null {
  let best: { action: string; date: string } | null = null
  for (const h of rec.legislationHistory ?? []) {
    const date = limsDate(h.actionDate)
    const action = clean(h.actionDescription)
    if (!date || !action || date > today) continue
    if (!best || date >= best.date) best = { action, date }
  }
  return best
}

export function toMasterListEntry(
  rec: LimsBulkRecord,
  billId: number,
  hash: string,
  storedDescription: string | null,
  today: string,
): SyncEntry {
  const last = lastAction(rec, today)
  const description = storedDescription
    ?? (isOversightCategory(rec) ? clean(rec.committeeReferral) || null : null)
  return {
    bill_id: billId,
    number: clean(rec.legislationNumber),
    change_hash: hash,
    title: clean(rec.title) || clean(rec.legislationNumber),
    description: description as string,
    status: limsMeasureStatus(rec),
    status_date: last?.date,
    last_action: last?.action,
    last_action_date: last?.date,
    state_link: limsBillUrl(clean(rec.legislationNumber)),
    bill_type: clean(rec.legislationSubCategory) || clean(rec.legislationCategory) || undefined,
  }
}

// ── BulkData + LegislationDetails → CentralMeasure ──────────────────────────────

export interface LimsPerson { peopleId: number; name: string; role: string }

export interface BuildContext {
  session: { session_id: number; session_name: string; year_start: number; year_end: number }
  /** Councilmembers, from indexPeople(). */
  people: Map<string, LimsPerson>
  today: string
}

const TEXT_KINDS: Record<string, { type: string; typeId: number }> = {
  Introduction: { type: 'Introduced', typeId: 1 },
  Committee_Print: { type: 'Committee Print', typeId: 2 },
  Engrossment: { type: 'Engrossed', typeId: 4 },
  Enrollment: { type: 'Enrolled', typeId: 5 },
  Signed_Act: { type: 'Signed Act', typeId: 6 },
}

/** LegiScan supplement type ids: 1 Fiscal Note, 2 Analysis, 7 Miscellaneous. */
function supplementType(kind: string, name?: string): { type: string; typeId: number } {
  const label = clean(name) || kind.replace(/_/g, ' ')
  if (/fiscal/i.test(label)) return { type: label, typeId: 1 }
  if (/committee report/i.test(label)) return { type: label, typeId: 2 }
  return { type: label, typeId: 7 }
}

/**
 * Event rows in bulk history, as LIMS words them: "Public Hearing on B26-0400",
 * "Roundtable on PR26-0009", "Oversight Hearing on ...", "Roundtable Meeting -
 * PR26-...", "Public Hearing Meeting - ...", "Committee Mark-up of B26-0400".
 * Notices ("Notice of Public Hearing ...") and cancellations are not events.
 */
const HEARING_RE = /^(Public (Hearing|Roundtable)|Public Oversight (Hearing|Roundtable)|Oversight Hearing|Roundtable)( Meeting)?( on\b| -)/i
const MARKUP_RE = /^Committee Mark-?up\b/i

/** Calendar event types (vocabulary.ts). */
const HEARING_TYPE_ID = 1
const MARKUP_TYPE_ID = 3
const DEADLINE_TYPE_ID = 10

const LIMS_DATE = '([A-Z][a-z]{2} \\d{1,2}, \\d{4})'
const MAYOR_DUE_RE = new RegExp(`Response Due on ${LIMS_DATE}`, 'i')
const PROJECTED_RE = new RegExp(`Projected Law Date is ${LIMS_DATE}`, 'i')
const EXPIRES_RE = new RegExp(`Expires on ${LIMS_DATE}`, 'i')

/**
 * The deadlines the Council records for a measure: the Mayor's response due
 * date, the projected law date at the end of Congressional review, and when an
 * emergency act or temporary law expires. LIMS states each date, so none is
 * computed (the projected law date already counts only the days Congress is in
 * session). The latest history entry that states each one wins, since a
 * re-transmittal or a new publication restates it. A measure has at most one
 * of each, so each kind of deadline is one event for good (`key`), and a
 * deadline that moves is that event on a new day.
 *
 * Only the BulkData record, never the details response: core rechecks a
 * missing calendar entry against the record's hash (lib/billCalendar.ts),
 * which covers the bulk record alone. The extras show the details' copies of
 * these dates.
 */
export function limsDeadlines(
  rec: Pick<LimsBulkRecord, 'legislationSubCategory' | 'projectedLawDate' | 'legislationHistory'>,
): { key: 'mayor-response' | 'congressional-review' | 'expires'; date: string; description: string }[] {
  const stated = (re: RegExp): string | null => {
    let found: string | null = null
    for (const h of rec.legislationHistory ?? []) {
      const m = re.exec(clean(h.actionDescription))
      if (m) found = limsDate(m[1]) ?? found
    }
    return found
  }
  const out: ReturnType<typeof limsDeadlines> = []
  const due = stated(MAYOR_DUE_RE)
  if (due) out.push({ key: 'mayor-response', date: due, description: 'Mayor\'s response due' })
  const projected = limsDate(clean(rec.projectedLawDate)) ?? stated(PROJECTED_RE)
  if (projected) out.push({ key: 'congressional-review', date: projected, description: 'Congressional review ends' })
  const expires = stated(EXPIRES_RE)
  if (expires) {
    const sub = clean(rec.legislationSubCategory).toLowerCase()
    const description = sub.includes('emergency') ? 'Emergency act expires'
      : sub.includes('temporary') ? 'Temporary law expires'
      : 'Expires'
    out.push({ key: 'expires', date: expires, description })
  }
  return out
}


function voteBucket(vote: string): { key: 'yea' | 'nay' | 'nv' | 'absent'; id: number } {
  const v = clean(vote).toLowerCase()
  if (v === 'yes' || v === 'aye' || v === 'yea') return { key: 'yea', id: 1 }
  if (v === 'no' || v === 'nay') return { key: 'nay', id: 2 }
  if (v.startsWith('absent') || v === 'excused' || v === 'not voting') return { key: 'absent', id: 4 }
  return { key: 'nv', id: 3 }
}

/**
 * Meeting videos from the details response, each with the history entry it
 * records: a hearing's goes on that day's hearing entry, a mark-up's on that
 * day's mark-up entry, and a floor reading's on the entry with the reading's
 * own wording ("First Reading, CC"). A video with no such entry is left out
 * (a reading's video still links from its roll call).
 */
function historyVideos(details: LimsLegislationDetails | null): (date: string | null, action: string) => string | undefined {
  const videos: { date: string | null; matches: (action: string) => boolean; url: string }[] = []
  for (const h of details?.committeeHearing ?? []) {
    if (clean(h.videoLink)) videos.push({ date: limsDate(h.hearingDate), matches: a => HEARING_RE.test(a), url: clean(h.videoLink) })
  }
  for (const m of details?.committeeMarkup ?? []) {
    if (clean(m.videoLink)) videos.push({ date: limsDate(m.committeeActionDate), matches: a => MARKUP_RE.test(a), url: clean(m.videoLink) })
  }
  for (const a of details?.actions ?? []) {
    const wording = clean(a.action).toLowerCase()
    if (clean(a.videoLink)) videos.push({ date: limsDate(a.actionDate), matches: x => x.toLowerCase() === wording, url: clean(a.videoLink) })
  }
  return (date, action) => {
    const i = videos.findIndex(v => v.date !== null && v.date === date && v.matches(action))
    return i < 0 ? undefined : videos.splice(i, 1)[0].url
  }
}

/** A string field's value for an extra, or null for anything else. */
function extraText(value: unknown): string | null {
  return typeof value === 'string' ? clean(value) || null : null
}

/** A date field's value for an extra, as YYYY-MM-DD, or null. */
function extraDate(value: unknown): string | null {
  return typeof value === 'string' ? limsDate(value) : null
}

/**
 * The measure's extras (vocabulary.ts): numbers, review dates, and the like
 * from the details response, with the bulk record's copies where details have
 * none.
 */
export function limsExtras(rec: LimsBulkRecord, details: LimsLegislationDetails | null): Record<string, string | null> {
  const mayor = details?.mayoralReview
  const congress = details?.congressionalReview
  const actRes = extraText(rec.actResNumber) ?? ''
  const comments = (details?.committeesReferredToWithComments ?? []).map(extraText).filter(Boolean)
  return {
    lawNumber: extraText(congress?.lawNumber) ?? extraText(rec.lawNumber),
    actNumber: extraText(mayor?.actNumber) ?? (/^A\d/i.test(actRes) ? actRes : null),
    resolutionNumber: /^R\d/i.test(actRes) ? actRes : null,
    requestedBy: extraText(details?.atTheRequestOf),
    commentCommittees: comments.length > 0 ? comments.join(', ') : null,
    sentToMayor: extraDate(mayor?.transmittedDate),
    mayorDeadline: extraDate(mayor?.responseDueDate),
    signedByMayor: extraDate(mayor?.signedDate),
    vetoedByMayor: extraDate(mayor?.vetoDate),
    enacted: extraDate(mayor?.enactedDate),
    actExpires: extraDate(mayor?.expirationDate),
    sentToCongress: extraDate(congress?.transmittedDate),
    projectedLawDate: extraDate(congress?.lawProjectedDate) ?? extraDate(rec.projectedLawDate),
    lawEffective: extraDate(congress?.effectiveDate),
    lawExpires: extraDate(congress?.expirationDate),
    withdrawnBy: extraText(details?.withdrawnBy),
    withdrawnOn: extraDate(details?.withdrawnDate),
  }
}

/**
 * The referrals one LIMS referral field names, each in its canonical form.
 * LegislationDetails lists committees by short name ("Youth Affairs"), and a
 * BulkData record in one sentence ("Committee on Youth Affairs, and Committee
 * on Judiciary and Public Safety", or "Retained by the Council with comments
 * from the Committee of the Whole"). Both become the Council's own names
 * ("Committee on Youth Affairs"), so a committee reads the same on every
 * measure. Committees asked only for comments aren't referrals (they're the
 * commentCommittees extra), and "Retained by the Council" stays as it is,
 * since it names no committee.
 */
export function referralParts(field: string | null | undefined): string[] {
  // A comments clause runs to the next ", and Committee ...", which is a referral again.
  const text = clean(field).replace(/\s+with comments from\b.*?(?=,?\s+and\s+(?:the\s+)?committee\b|$)/i, '')
  if (!text) return []
  return text
    .split(/,?\s+and\s+(?=(?:the\s+)?(?:special\s+)?committee\b)|,\s*(?=(?:the\s+)?(?:special\s+)?committee\b)/i)
    .map(part => clean(part).replace(/^the\s+/i, ''))
    .filter(Boolean)
    .map(part => (/^whole$/i.test(part) ? 'Committee of the Whole'
      : /\bcommittee\b/i.test(part) || /^retained by\b/i.test(part) ? part
      : `Committee on ${part}`))
}

/** Whether a canonical referral names a committee (and isn't "Retained by the Council"). */
const namesCommittee = (name: string) => /\bcommittee\b/i.test(name)

/** A committee's native key in central's id table: its canonical name, with case and spacing folded. */
export function committeeKey(name: string): string {
  return clean(name).toLowerCase()
}

/**
 * Give each referral that names a committee its central committee id, minted
 * from central's id table (kind 'committee') by committeeKey, so every measure
 * referred to a committee points at the same committees row.
 */
export async function assignCommitteeIds(
  measure: CentralMeasure,
  ids: (kind: string, nativeKeys: readonly string[]) => Promise<Map<string, number>>,
): Promise<void> {
  const named = measure.referrals.filter(r => namesCommittee(r.name))
  if (named.length === 0) return
  const byKey = await ids('committee', named.map(r => committeeKey(r.name)))
  for (const r of named) r.committee_id = byKey.get(committeeKey(r.name)) ?? 0
}

export async function buildLimsBill(
  rec: LimsBulkRecord,
  details: LimsLegislationDetails | null,
  billId: number,
  hash: string,
  ctx: BuildContext,
): Promise<CentralMeasure> {
  const number = clean(rec.legislationNumber)
  const history = (rec.legislationHistory ?? [])
    .map(h => ({ date: limsDate(h.actionDate), action: clean(h.actionDescription), doc: parseDocUrl(h.downloadURL) }))

  // ── Documents: every download URL, de-duplicated by its Id ──
  const texts: CentralMeasure['texts'] = []
  const supplements: CentralMeasure['supplements'] = []
  const amendments: CentralMeasure['amendments'] = []
  const seen = new Set<number>()
  const addDoc = async (doc: LimsDocRef | null, date: string | null, title: string, typeName?: string) => {
    if (!doc || seen.has(doc.id)) return
    seen.add(doc.id)
    const id = limsDocId(doc.id)
    const h = await docHash(doc.id)
    const text = TEXT_KINDS[doc.kind]
    if (text) {
      texts.push({
        doc_id: id, date: date ?? '', type: text.type, type_id: text.typeId,
        mime: 'application/pdf', mime_id: 2, url: '', state_link: doc.url,
        text_size: 0, text_hash: h,
        alt_bill_text: 0, alt_mime: '', alt_mime_id: 0, alt_state_link: '', alt_text_size: 0, alt_text_hash: '',
      })
    } else if (doc.kind === 'Amendment') {
      amendments.push({
        amendment_id: id, adopted: 0, chamber: '', date: date ?? '', title: title || 'Amendment',
        description: '', mime: 'application/pdf', url: '', state_link: doc.url,
        amendment_size: 0, amendment_hash: h,
      })
    } else {
      const t = supplementType(doc.kind, typeName)
      supplements.push({
        supplement_id: id, date: date ?? '', type_id: t.typeId, type: t.type, title: title || t.type,
        description: '', mime: 'application/pdf', url: '', state_link: doc.url,
        supplement_size: 0, supplement_hash: h,
      })
    }
  }
  for (const h of history) await addDoc(h.doc, h.date, h.action)
  if (details) {
    await addDoc(parseDocUrl(details.legislationDocument), limsDate(details.introductionDate), 'Introduction')
    for (const m of details.committeeMarkup ?? []) {
      const date = limsDate(m.committeeActionDate)
      await addDoc(parseDocUrl(m.committeePrint), date, 'Committee Print')
      await addDoc(parseDocUrl(m.committeeReport), limsDate(m.reportFiledDate) ?? date, 'Committee Report', 'Committee Report')
    }
    for (const hr of details.committeeHearing ?? []) {
      const date = limsDate(hr.hearingDate)
      await addDoc(parseDocUrl(hr.hearingNotice), limsDate(hr.noticeFiledDate) ?? date, 'Hearing Notice')
      await addDoc(parseDocUrl(hr.hearingRecord), date, 'Hearing Record')
      await addDoc(parseDocUrl(hr.cancellationHearingNotice), date, 'Hearing Cancellation Notice')
    }
    for (const d of details.otherDocuments ?? []) {
      await addDoc(parseDocUrl(d.url), null, documentTitle(d, number), d.documentTypeName)
    }
    for (const a of details.actions ?? []) {
      await addDoc(parseDocUrl(a.attachment), limsDate(a.actionDate), clean(a.action))
    }
    const mayor = details.mayoralReview
    if (typeof mayor?.signedAct === 'string') await addDoc(parseDocUrl(mayor.signedAct), limsDate(mayor.signedDate), 'Signed Act')
  }

  // ── Calendar: hearings and mark-ups from history, notices (hearings themselves), and deadlines ──
  // LIMS publishes no event ids, so core identifies each entry by its kind,
  // date, and text: two hearings with the same text on different days are two
  // entries, and neither is numbered by position.
  //
  // Cancellations come from details, whose hearing entries name the cancelled
  // hearing's date and type. That notice is positive evidence, so the entry
  // goes out marked cancelled and core cancels it at once. Bulk cancellation
  // entries ("Cancellation Notice of Roundtable ...", "Roundtable Canceled")
  // are not used: an event row after a cancellation is the rescheduled
  // hearing (e.g. PR26-0264, cancelled Sep 18 2025 and held Sep 26 with a
  // published record).
  const cancelledTypes = new Map<string, string>()
  for (const h of details?.committeeHearing ?? []) {
    const date = limsDate(h.hearingDate)
    if (date && h.cancellationHearingNotice) cancelledTypes.set(date, clean(h.hearingType))
  }
  const events: (Omit<MeasureCalendarEntry, 'time' | 'event_hash'>)[] = []
  if (isNoticeCategory(rec)) {
    const date = limsDate(rec.introductionDate)
    if (date) events.push({ type_id: HEARING_TYPE_ID, type: 'Hearing', date, description: clean(rec.title), location: clean(rec.committeeReferral) })
  }
  for (const h of history) {
    if (!h.date) continue
    if (HEARING_RE.test(h.action)) {
      events.push({
        type_id: HEARING_TYPE_ID, type: 'Hearing', date: h.date,
        description: h.action.replace(/ View (Public Hearing|Roundtable) Record$/i, ''), location: '',
        ...(cancelledTypes.has(h.date) ? { cancelled: true } : {}),
      })
    } else if (MARKUP_RE.test(h.action)) {
      events.push({ type_id: MARKUP_TYPE_ID, type: 'Markup Session', date: h.date, description: h.action, location: '' })
    }
  }
  // A cancelled hearing can drop out of the history. Its notice still names the
  // date and type, and LIMS words a hearing "<type> on <number>", so the
  // cancellation still reaches the entry the history listed.
  for (const [date, type] of cancelledTypes) {
    if (type && !events.some(e => e.type_id === HEARING_TYPE_ID && e.date === date)) {
      events.push({ type_id: HEARING_TYPE_ID, type: 'Hearing', date, description: `${type} on ${number}`, location: '', cancelled: true })
    }
  }
  for (const d of limsDeadlines(rec)) {
    events.push({ type_id: DEADLINE_TYPE_ID, type: 'Deadline', date: d.date, description: d.description, location: '', event_id: `deadline:${d.key}` })
  }
  events.sort((a, b) => a.date.localeCompare(b.date))
  // Every measure's history starts with its introduction, so a record with
  // none is a bad answer, not a measure whose hearings all went away. It
  // sends no calendar at all, which core reads as no evidence either way.
  let calendar: MeasureCalendarEntry[] | undefined
  if (history.length > 0 || isNoticeCategory(rec)) {
    calendar = []
    for (const e of events) {
      calendar.push({
        ...e, time: '',
        event_hash: (await sha256Hex(`${e.type_id}|${e.date}|${e.description}|${e.location}`)).slice(0, 32),
      })
    }
  }

  // ── Sponsors ──
  const sponsors: CentralMeasure['sponsors'] = []
  const addSponsors = (members: LimsMember[] | null | undefined, typeId: number) => {
    for (const m of members ?? []) {
      const person = findPerson(ctx.people, m.memberName)
      if (!person) {
        console.warn(`[lims-map] ${number}: no Councilmember matches sponsor "${clean(m.memberName)}"`)
        continue
      }
      if (sponsors.some(s => s.people_id === person.peopleId)) continue
      sponsors.push({
        people_id: person.peopleId, name: person.name, party: '', role: person.role, role_id: 0,
        district: '', sponsor_type_id: typeId, sponsor_order: sponsors.length + 1,
      })
    }
  }
  addSponsors(details?.introducers, 1)
  addSponsors(details?.coIntroducers, 2)
  addSponsors(details?.coSponsors, 2)

  // ── Councilmember votes (on floor readings) ──
  const votes: CentralMeasure['votes'] = []
  for (const a of details?.actions ?? []) {
    const vd = a.voteDetails
    if (!vd) continue
    const counts = { yea: 0, nay: 0, nv: 0, absent: 0 }
    const memberVotes = (vd.votes ?? []).map(v => {
      const b = voteBucket(v.vote)
      counts[b.key]++
      return { people_id: findPerson(ctx.people, v.councilMember)?.peopleId ?? null, vote_id: b.id, vote_text: clean(v.vote) }
    })
    const date = limsDate(a.actionDate) ?? ''
    votes.push({
      roll_call_id: limsRollCallId(billId, votes.length),
      date, desc: [clean(a.action), clean(vd.voteType)].filter(Boolean).join(' — '),
      yea: counts.yea, nay: counts.nay, nv: counts.nv, absent: counts.absent,
      total: memberVotes.length, passed: /^(approved|adopted|passed|confirmed)\b/i.test(clean(vd.voteResult)) ? 1 : 0,
      chamber: 'C', chamber_id: 0, url: '', state_link: clean(a.videoLink),
      member_votes: memberVotes,
    })
  }

  // ── Referrals ── (fetchMeasure sets their committee ids, assignCommitteeIds)
  const referralDate = limsDate(details?.committeeReferralDate) ?? ''
  const referralNames = details?.committeesReferredTo?.length
    ? details.committeesReferredTo.flatMap(referralParts)
    : referralParts(rec.committeeReferral)
  const referrals = [...new Set(referralNames)]
    .map(name => ({ date: referralDate, committee_id: 0, chamber: 'C', chamber_id: 0, name }))

  const last = lastAction(rec, ctx.today)
  const description = clean(details?.shortDescription) || clean(details?.additionalInformation)
    || (isOversightCategory(rec) ? clean(rec.committeeReferral) : '') || clean(rec.title)
  const videoFor = historyVideos(details)

  return {
    bill_id: billId,
    bill_number: number,
    title: clean(details?.title) || clean(rec.title) || number,
    description,
    state: LIMS_STATE,
    state_id: DC_STATE_ID,
    change_hash: hash,
    status: limsMeasureStatus(rec, details?.status),
    status_date: last?.date ?? '',
    bill_type: clean(rec.legislationSubCategory) || clean(rec.legislationCategory),
    bill_type_id: /^[A-Z]+/.exec(number)?.[0] ?? '',
    body: 'C',
    body_id: 0,
    current_body: 'C',
    current_body_id: 0,
    url: '',
    state_link: limsBillUrl(number),
    pending_committee_id: 0,
    session_id: ctx.session.session_id,
    session: ctx.session,
    committee: null,
    referrals,
    progress: [],
    sponsors,
    history: history
      .filter(h => h.date && h.action)
      .map(h => {
        const video = videoFor(h.date, h.action)
        return {
          date: h.date!, action: h.action, chamber: 'C', chamber_id: 0,
          importance: /Introduced|Reading|Enacted|Law |Signed|Vetoed|Withdrawn|Adopted|Approved|Disapproved|Tabled/i.test(h.action) ? 1 : 2,
          ...(video ? { video_url: video } : {}),
        }
      }),
    sasts: [],
    subjects: [],
    votes,
    texts,
    calendar,
    amendments,
    supplements,
    extras: limsExtras(rec, details),
  }
}
