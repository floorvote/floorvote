import { htmlToText, sha256Hex, type CentralMeasure } from '../sdk'
import { BILL_TYPE, govinfoNativeKey, invalidBillFile, legiscanNumber, ordinal, type CongressBillType, type GovInfoRecord } from './map'
import { actionItems, child, childText, GOVINFO_STATUS } from './status'
import { parseXml, XmlError, type XmlNode } from './xml'

/**
 * A tracked bill's detail, read from its whole Bill Status file at ingest: its
 * history, sponsors, texts, committees, subjects, related bills, and extras.
 * The full read (map.ts) keeps only a compact record, so the ingest downloads
 * the file again (client.ts, `fetchBillStatusFile`) and reads it here.
 *
 * Two steps, so a bad file mints nothing. `readBillDetail` is pure: it reads
 * and checks the whole file, and throws on anything it can't read, before
 * central's id table is asked for a single id. `resolveDetail` then turns the
 * keys it read (a Bioguide id, a package id, a committee system code) into
 * central ids, in the shapes the ingest writes.
 *
 * Fails closed: a missing or malformed entry throws, so the ingest writes
 * nothing for the bill and is retried. A version GovInfo has published no
 * file for yet isn't an error: it has nothing to link, and the next ingest
 * picks it up.
 */

const DATE = /^\d{4}-\d{2}-\d{2}$/
const BIOGUIDE = /^[A-Z]\d{6}$/
const SYSTEM_CODE = /^[a-z]{4}\d{2}$/
/** A package's address on GovInfo: `.../content/pkg/BILLS-119hr3132ih/xml/BILLS-119hr3132ih.xml`, or `PLAW-119publ23` for a law. */
const PACKAGE_URL = /^https:\/\/www\.govinfo\.gov\/content\/pkg\/((?:BILLS|PLAW)-[A-Za-z0-9]+)\/[a-z]+\/\1\.[a-z]+$/

const CHAMBER_ID = { H: 1, S: 2 } as const
type Chamber = keyof typeof CHAMBER_ID

/** Action types that count for most: a floor vote, the President's action, becoming law, and a veto. */
const IMPORTANT_ACTIONS = new Set(['Floor', 'President', 'BecameLaw', 'Veto'])
/** The action codes of a chamber passing a measure (status.ts reads the same two). */
const PASSED_HOUSE = '8000'
const PASSED_SENATE = '17000'

/** LegiScan's text type ids, for the four types a version maps to. */
const TEXT_TYPE: Record<string, { label: string; id: number }> = {
  'Introduced in House': { label: 'Introduced', id: 1 },
  'Introduced in Senate': { label: 'Introduced', id: 1 },
  'Engrossed in House': { label: 'Engrossed', id: 4 },
  'Engrossed in Senate': { label: 'Engrossed', id: 4 },
  'Engrossed Amendment House': { label: 'Engrossed', id: 4 },
  'Engrossed Amendment Senate': { label: 'Engrossed', id: 4 },
  'Agreed to House': { label: 'Engrossed', id: 4 },
  'Agreed to Senate': { label: 'Engrossed', id: 4 },
  'Enrolled Bill': { label: 'Enrolled', id: 5 },
  'Public Law': { label: 'Chaptered', id: 6 },
  'Private Law': { label: 'Chaptered', id: 6 },
}

/**
 * The relationship labels in the order they win when the Library of Congress
 * names a bill in more than one way: the same text filed in both chambers
 * first, the generic "Related bill" last, and a label not listed between.
 */
const RELATIONSHIP_ORDER = [
  'Identical bill', 'Procedurally related', 'Contained in public law', 'Public law contains the text',
  'PrimaryCompanionBillBecameLaw', 'SecondaryCompanionBillBecameLaw', 'Cross-Congress related bill',
]
const RELATIONSHIP_GENERIC = 'Related bill'
const RELATIONSHIP_TYPE_ID: Record<string, number> = {
  'Identical bill': 1, 'Related bill': 2, 'Procedurally related': 3, 'Cross-Congress related bill': 4,
  'Contained in public law': 5, 'Public law contains the text': 6,
  'PrimaryCompanionBillBecameLaw': 7, 'SecondaryCompanionBillBecameLaw': 8,
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

export interface DetailAction { date: string; text: string; chamber: Chamber | ''; importance: 1 | 2 }

export interface DetailPerson {
  bioguideId: string
  name: string
  firstName: string
  middleName: string
  lastName: string
  party: string
  role: 'Rep' | 'Sen' | 'Del'
  /** A House member's "MI-1" (or "AK-AL" at large) and a senator's state: the one place a member's state is kept. */
  district: string
}

export interface DetailText { packageId: string; type: string; typeId: number; date: string; link: string }

export interface DetailCommittee { systemCode: string; name: string; chamber: Chamber }

export interface DetailRelated { key: string; number: string; label: string }

/** What one Bill Status file says about a bill, by the file's own keys. */
export interface BillDetail {
  /** Oldest first. */
  history: DetailAction[]
  sponsor: DetailPerson
  /** In the feed's order, withdrawn ones left out. */
  cosponsors: DetailPerson[]
  texts: DetailText[]
  committees: DetailCommittee[]
  /** Oldest first, by the committee's system code. */
  referrals: { date: string; systemCode: string }[]
  pendingCommittee: string | null
  subjects: string[]
  related: DetailRelated[]
  extras: Record<string, string>
}

/** The text of every child of `node` named `name`, trimmed, blanks left out. */
const texts = (node: XmlNode | undefined, name: string): string[] =>
  (node?.children ?? []).filter(c => c.name === name).map(c => c.text.trim()).filter(Boolean)

const items = (node: XmlNode | undefined): XmlNode[] => node?.children.filter(c => c.name === 'item') ?? []

/**
 * Read a bill's detail from its whole file. `record` is what the full read
 * stored for the bill: the file must be that bill, and its status and chamber
 * decide what the pending committee can be.
 */
export function readBillDetail(name: string, xml: string, record: GovInfoRecord): BillDetail {
  let root: XmlNode
  try {
    ({ root } = parseXml(xml))
  } catch (err) {
    if (err instanceof XmlError) throw invalidBillFile(name, err.message)
    throw err
  }
  if (root.name !== 'billStatus') throw invalidBillFile(name, `its root is <${root.name}>, not <billStatus>`)
  const bill = child(root, 'bill')
  if (!bill) throw invalidBillFile(name, 'it has no <bill>')
  const type = childText(bill, 'type')
  if (type !== record.type || Number(childText(bill, 'congress')) !== record.congress || childText(bill, 'number') !== record.number) {
    throw invalidBillFile(name, `it is ${childText(bill, 'type') || '(no type)'} ${childText(bill, 'number') || '(no number)'} of Congress ${childText(bill, 'congress') || '(none)'}, not ${record.type} ${record.number} of Congress ${record.congress}`)
  }

  const actions = readActions(name, bill)
  const committees = readCommittees(name, bill)
  const { sponsor, cosponsors } = readSponsors(name, bill)
  return {
    history: actions.history,
    sponsor,
    cosponsors,
    texts: readTexts(name, bill, record, actions.passages),
    committees: committees.committees,
    referrals: committees.referrals,
    pendingCommittee: pendingCommittee(committees, record),
    subjects: readSubjects(name, bill),
    related: readRelated(name, bill, record),
    extras: readExtras(bill),
  }
}

// ---- History

function readActions(file: string, bill: XmlNode): { history: DetailAction[]; passages: { code: string; date: string }[] } {
  const history: DetailAction[] = []
  const passages: { code: string; date: string }[] = []
  let introduced = false
  // The feed lists a bill's newest action first, so oldest first is the list reversed (status.ts reads it the same way).
  for (const a of actionItems(bill).reverse()) {
    const code = childText(a, 'actionCode')
    const source = childText(child(a, 'sourceSystem') ?? a, 'name')
    const library = source === 'Library of Congress'
    // The Library of Congress records an introduction twice: as "Introduced in House" or "Introduced in Senate" (codes 1000 and 10000), and under its older
    // code Intro-H or Intro-S, which for some bills has no text at all. The older one is the duplicate. A few bills are introduced twice over, and one stays.
    if (library && (code === 'Intro-H' || code === 'Intro-S')) continue
    const date = childText(a, 'actionDate')
    const text = childText(a, 'text')
    if (!DATE.test(date)) throw invalidBillFile(file, `an action has no date ("${date}")`)
    if (!text) throw invalidBillFile(file, `the action of ${date} has no text`)
    if (library && /^Introduced in (House|Senate)$/.test(text)) {
      if (introduced) continue
      introduced = true
    }
    if (code === PASSED_HOUSE || code === PASSED_SENATE) passages.push({ code, date })
    history.push({
      date,
      text,
      // The chamber comes from the source system. The Library of Congress writes summary actions for both, so it has none.
      chamber: source.startsWith('House') ? 'H' : source === 'Senate' ? 'S' : '',
      importance: IMPORTANT_ACTIONS.has(childText(a, 'type')) ? 1 : 2,
    })
  }
  // Already oldest first. A stable sort keeps the feed's order within a day, and puts a feed that isn't newest first in order too.
  history.sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0))
  return { history, passages }
}

// ---- Sponsors

const ROLE: Record<string, DetailPerson['role']> = { 'Rep.': 'Rep', 'Sen.': 'Sen', 'Del.': 'Del', 'Rescom.': 'Del' }

function readPerson(file: string, node: XmlNode, what: string): DetailPerson {
  const bioguideId = childText(node, 'bioguideId')
  if (!BIOGUIDE.test(bioguideId)) throw invalidBillFile(file, `${what} has no Bioguide id ("${bioguideId}")`)
  const firstName = childText(node, 'firstName')
  const middleName = childText(node, 'middleName')
  const lastName = childText(node, 'lastName')
  if (!lastName) throw invalidBillFile(file, `${what} (${bioguideId}) has no last name`)
  const title = childText(node, 'fullName').split(' ')[0]
  const role = Object.hasOwn(ROLE, title) ? ROLE[title] : undefined
  if (!role) throw invalidBillFile(file, `${what} (${bioguideId}) has a title "${title}" that isn't Rep., Sen., Del., or Rescom.`)
  const state = childText(node, 'state')
  if (!/^[A-Z]{2}$/.test(state)) throw invalidBillFile(file, `${what} (${bioguideId}) has no state`)
  const district = childText(node, 'district')
  return {
    bioguideId,
    name: [firstName, middleName, lastName].filter(Boolean).join(' '),
    firstName, middleName, lastName,
    party: childText(node, 'party'),
    role,
    // The feed gives an at-large seat no district at all, or district 0 (Delaware, and the delegates).
    district: role === 'Sen' ? state : `${state}-${district === '' || district === '0' ? 'AL' : district}`,
  }
}

function readSponsors(file: string, bill: XmlNode): { sponsor: DetailPerson; cosponsors: DetailPerson[] } {
  const sponsors = items(child(bill, 'sponsors'))
  if (sponsors.length !== 1) throw invalidBillFile(file, `it has ${sponsors.length} sponsors, not one`)
  const cosponsors = items(child(bill, 'cosponsors'))
    .filter(c => !childText(c, 'sponsorshipWithdrawnDate'))
    .map(c => readPerson(file, c, 'a cosponsor'))
  return { sponsor: readPerson(file, sponsors[0], 'the sponsor'), cosponsors }
}

// ---- Texts

function packageOf(file: string, urls: string[]): string | null {
  if (urls.length === 0) return null
  const packages = new Set(urls.map(url => {
    const m = PACKAGE_URL.exec(url)
    if (!m) throw invalidBillFile(file, `a text version links "${url}", which isn't a GovInfo package`)
    return m[1]
  }))
  if (packages.size > 1) throw invalidBillFile(file, `a text version links more than one package (${[...packages].join(', ')})`)
  return [...packages][0]
}

/** The date of the action a version with no date of its own matches: when its text came to be. */
function fallbackDate(file: string, type: string, record: GovInfoRecord, passages: { code: string; date: string }[]): string {
  const dates = (code?: string) => passages.filter(p => !code || p.code === code).map(p => p.date)
  let found: string | undefined
  if (/^Enrolled/.test(type)) found = dates().at(-1) // the second chamber's passage, which enrolls the bill
  else if (/^Introduced/.test(type)) found = record.introducedDate
  else if (/^(Engrossed|Agreed to)/.test(type) && /House$/.test(type)) found = dates(PASSED_HOUSE)[0]
  else if (/^(Engrossed|Agreed to)/.test(type) && /Senate$/.test(type)) found = dates(PASSED_SENATE)[0]
  if (!found) throw invalidBillFile(file, `the "${type}" text version has no date, and the bill has no action to take one from`)
  return found
}

function readTexts(file: string, bill: XmlNode, record: GovInfoRecord, passages: { code: string; date: string }[]): DetailText[] {
  const out: DetailText[] = []
  for (const v of items(child(bill, 'textVersions'))) {
    const type = childText(v, 'type')
    if (!type) throw invalidBillFile(file, 'a text version has no type')
    const packageId = packageOf(file, items(child(v, 'formats')).flatMap(f => texts(f, 'url')))
    // GovInfo hasn't published this version yet. Nothing to link, and no id to mint.
    if (!packageId) continue
    const rawDate = childText(v, 'date')
    let date: string
    if (!rawDate) date = fallbackDate(file, type, record, passages)
    else if (DATE.test(rawDate.slice(0, 10))) date = rawDate.slice(0, 10)
    else throw invalidBillFile(file, `the "${type}" text version has a date that isn't one ("${rawDate}")`)
    const mapped = Object.hasOwn(TEXT_TYPE, type) ? TEXT_TYPE[type] : { label: type, id: 0 }
    out.push({
      packageId, type: mapped.label, typeId: mapped.id, date,
      link: `https://www.govinfo.gov/content/pkg/${packageId}/pdf/${packageId}.pdf`,
    })
  }
  return out
}

// ---- Committees and referrals

interface Committees {
  committees: DetailCommittee[]
  referrals: { date: string; systemCode: string }[]
  /** The latest date each committee reported the bill or was discharged from it, or '' when the date is missing. */
  reported: Map<string, string[]>
}

const REPORTED_ACTIVITIES = new Set(['reported by', 'reported original measure', 'discharged from'])

function readCommittees(file: string, bill: XmlNode): Committees {
  const committees: DetailCommittee[] = []
  const referrals: { date: string; systemCode: string }[] = []
  const reported = new Map<string, string[]>()
  for (const c of items(child(bill, 'committees'))) {
    const systemCode = childText(c, 'systemCode')
    if (!SYSTEM_CODE.test(systemCode)) throw invalidBillFile(file, `a committee has a system code that isn't one ("${systemCode}")`)
    const name = childText(c, 'name')
    if (!name) throw invalidBillFile(file, `committee ${systemCode} has no name`)
    const chamberName = childText(c, 'chamber')
    const chamber: Chamber | undefined = chamberName === 'House' ? 'H' : chamberName === 'Senate' ? 'S' : undefined
    if (!chamber) throw invalidBillFile(file, `committee ${systemCode} is in "${chamberName}", not the House or Senate`)
    committees.push({ systemCode, name, chamber })
    // A committee's activities are listed newest first, so reversed they are oldest first.
    for (const a of items(child(c, 'activities')).reverse()) {
      const activity = childText(a, 'name').toLowerCase()
      const date = childText(a, 'date').slice(0, 10)
      if (activity === 'referred to') referrals.push({ date, systemCode })
      else if (REPORTED_ACTIVITIES.has(activity)) reported.set(systemCode, [...(reported.get(systemCode) ?? []), date])
    }
  }
  // Oldest first. A stable sort keeps the feed's committee order among referrals on one day.
  referrals.sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0))
  return { committees, referrals, reported }
}

/**
 * The committee a bill waits in: its latest referral that its committee
 * hasn't reported, or been discharged from, since. Where several are the
 * latest, the first the feed lists (the primary committee).
 *
 * Two guards the file doesn't make for itself. A bill that has passed both
 * chambers, been presented to the President, or become law waits in no
 * committee, and a bill in one chamber waits only in that chamber's (a House
 * committee that never reported a bill the House passed under a suspension of
 * the rules isn't holding it).
 */
function pendingCommittee({ committees, referrals, reported }: Committees, record: GovInfoRecord): string | null {
  const done: number[] = [GOVINFO_STATUS.passedBoth, GOVINFO_STATUS.presented, GOVINFO_STATUS.vetoed, GOVINFO_STATUS.becameLaw, GOVINFO_STATUS.agreedTo]
  if (done.includes(record.status)) return null
  const chamberOf = new Map(committees.map(c => [c.systemCode, c.chamber]))
  let latest: { date: string; systemCode: string } | null = null
  for (const r of referrals) {
    if (chamberOf.get(r.systemCode) !== record.currentChamber) continue
    // A report with no date counts as after the referral.
    if ((reported.get(r.systemCode) ?? []).some(d => !d || d >= r.date)) continue
    if (!latest || r.date > latest.date) latest = r
  }
  return latest?.systemCode ?? null
}

// ---- Subjects and related bills

function readSubjects(file: string, bill: XmlNode): string[] {
  const names: string[] = []
  const subjects = child(bill, 'subjects')
  for (const s of items(subjects && child(subjects, 'legislativeSubjects'))) {
    const name = childText(s, 'name')
    if (!name) throw invalidBillFile(file, 'a legislative subject has no name')
    if (!names.includes(name)) names.push(name)
  }
  return names
}

/** The label that wins among the ones a related bill is named by. */
function strongest(labels: string[]): string {
  const rank = (l: string) => (l === RELATIONSHIP_GENERIC ? RELATIONSHIP_ORDER.length + 1 : RELATIONSHIP_ORDER.includes(l) ? RELATIONSHIP_ORDER.indexOf(l) : RELATIONSHIP_ORDER.length)
  return labels.reduce((best, l) => (rank(l) < rank(best) ? l : best))
}

function readRelated(file: string, bill: XmlNode, record: GovInfoRecord): DetailRelated[] {
  const byKey = new Map<string, { number: string; labels: string[] }>()
  for (const r of items(child(bill, 'relatedBills'))) {
    const type = childText(r, 'type')
    const congress = Number(childText(r, 'congress'))
    const number = childText(r, 'number')
    if (!Object.hasOwn(BILL_TYPE, type)) throw invalidBillFile(file, `a related bill has a type "${type}" that isn't one of Congress's eight`)
    if (!Number.isInteger(congress) || congress < 1) throw invalidBillFile(file, `related bill ${type} ${number} has no Congress`)
    if (!/^[1-9]\d*$/.test(number)) throw invalidBillFile(file, `a related ${type} has no number`)
    const labels = items(child(r, 'relationshipDetails')).flatMap(d => texts(d, 'type'))
    if (labels.length === 0) throw invalidBillFile(file, `related bill ${type} ${number} says how it is related in no way`)
    if (congress === record.congress && type === record.type && number === record.number) continue
    const key = govinfoNativeKey(congress, type, number)
    const named = legiscanNumber({ type: type as CongressBillType, number })
    // A bill of another Congress has the number of this Congress's bill of its type, so it says which.
    const entry = byKey.get(key) ?? { number: congress === record.congress ? named : `${named} (${ordinal(congress)} Congress)`, labels: [] }
    entry.labels.push(...labels)
    byKey.set(key, entry)
  }
  return [...byKey].map(([key, e]) => ({ key, number: e.number, label: strongest(e.labels) }))
}

// ---- Extras

function readExtras(bill: XmlNode): Record<string, string> {
  const extras: Record<string, string> = {}

  // The latest summary: the newest by the date of its version, then by when it was last changed, then by its place in the feed.
  const summaries = (child(bill, 'summaries')?.children ?? []).filter(s => s.name === 'summary')
  let latest: XmlNode | undefined
  const sortKey = (s: XmlNode) => `${childText(s, 'actionDate')}|${childText(s, 'updateDate')}`
  for (const s of summaries) if (!latest || sortKey(s) >= sortKey(latest)) latest = s
  if (latest) {
    const body = child(latest, 'text') ?? child(child(latest, 'cdata') ?? latest, 'text')
    const text = body ? htmlToText(body.text) : ''
    if (text) {
      const desc = childText(latest, 'actionDesc')
      const when = /^(\d{4})-(\d{2})-(\d{2})$/.exec(childText(latest, 'actionDate'))
      const date = when ? `${MONTHS[Number(when[2]) - 1]} ${Number(when[3])}, ${when[1]}` : ''
      const version = [desc && `${desc} version`, date && (desc ? `(${date})` : date)].filter(Boolean).join(' ')
      extras.summary = version ? `${version}\n\n${text}` : text
    }
  }

  const law = items(child(bill, 'laws')).find(l => childText(l, 'type') === 'Public Law' && childText(l, 'number'))
  if (law) extras.publicLaw = childText(law, 'number')

  const policyArea = childText(child(bill, 'policyArea') ?? { name: '', text: '', children: [] }, 'name')
  if (policyArea) extras.policyArea = policyArea

  // The newest cost estimate with a link.
  let estimate: { date: string; url: string } | undefined
  for (const e of items(child(bill, 'cboCostEstimates'))) {
    const url = childText(e, 'url')
    const date = childText(e, 'pubDate')
    if (/^https?:\/\//.test(url) && (!estimate || date >= estimate.date)) estimate = { date, url }
  }
  if (estimate) extras.costEstimate = estimate.url

  return extras
}

// ---- Central ids

/** Every key of a bill's detail that central mints an id for, by kind (`ProviderContext.ids`). */
export function detailKeys(d: BillDetail): { person: string[]; doc: string[]; committee: string[]; subject: string[]; bill: string[] } {
  return {
    person: [d.sponsor, ...d.cosponsors].map(p => p.bioguideId),
    doc: d.texts.map(t => t.packageId),
    committee: d.committees.map(c => c.systemCode),
    subject: d.subjects,
    bill: d.related.map(r => r.key),
  }
}

export type DetailIds = Record<keyof ReturnType<typeof detailKeys>, Map<string, number>>

/** The parts of a measure a bill's detail fills. */
export type ResolvedDetail = Pick<CentralMeasure,
  'history' | 'sponsors' | 'texts' | 'committee' | 'pending_committee_id' | 'referrals' | 'subjects' | 'sasts' | 'extras'>

/** A bill's detail in the shapes the ingest writes, with every key replaced by its central id. */
export async function resolveDetail(d: BillDetail, ids: DetailIds): Promise<ResolvedDetail> {
  const id = (kind: keyof DetailIds, key: string): number => {
    const found = ids[kind].get(key)
    if (found === undefined) throw new Error(`central minted no ${kind} id for ${key}`)
    return found
  }
  const committeeOf = new Map(d.committees.map(c => [c.systemCode, c]))
  const committeeRef = (systemCode: string) => {
    const c = committeeOf.get(systemCode)!
    return { committee_id: id('committee', systemCode), chamber: c.chamber, chamber_id: CHAMBER_ID[c.chamber], name: c.name }
  }
  const pending = d.pendingCommittee ? committeeRef(d.pendingCommittee) : null

  const person = (p: DetailPerson, type: 1 | 2, order: number) => ({
    people_id: id('person', p.bioguideId),
    name: p.name,
    first_name: p.firstName || undefined,
    middle_name: p.middleName || undefined,
    last_name: p.lastName,
    party: p.party,
    role: p.role,
    role_id: p.role === 'Sen' ? 2 : 1,
    district: p.district,
    bioguide_id: p.bioguideId,
    sponsor_type_id: type,
    sponsor_order: order,
  })

  return {
    history: d.history.map(h => ({
      date: h.date, action: h.text, chamber: h.chamber, chamber_id: h.chamber ? CHAMBER_ID[h.chamber] : 0, importance: h.importance,
    })),
    sponsors: [person(d.sponsor, 1, 1), ...d.cosponsors.map((c, i) => person(c, 2, i + 2))],
    texts: await Promise.all(d.texts.map(async t => ({
      doc_id: id('doc', t.packageId), date: t.date, type: t.type, type_id: t.typeId,
      mime: 'application/pdf', mime_id: 2, url: '', state_link: t.link, text_size: 0,
      text_hash: await sha256Hex(`govinfo:${t.packageId}`),
      alt_bill_text: 0, alt_mime: '', alt_mime_id: 0, alt_state_link: '', alt_text_size: 0, alt_text_hash: '',
    }))),
    committee: pending,
    pending_committee_id: pending?.committee_id ?? 0,
    referrals: d.referrals.map(r => ({ date: r.date, ...committeeRef(r.systemCode) })),
    subjects: d.subjects.map(name => ({ subject_id: id('subject', name), subject_name: name })),
    sasts: d.related.map(r => ({
      type_id: RELATIONSHIP_TYPE_ID[r.label] ?? 0, type: r.label, sast_bill_number: r.number, sast_bill_id: id('bill', r.key),
    })),
    extras: d.extras,
  }
}
