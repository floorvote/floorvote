import { sha256Hex, type CentralMeasure, type SyncEntry } from '../sdk'
import { child, childText, deriveStatus } from './status'
import { parseXml, XmlError, type XmlNode } from './xml'

/**
 * Pure mapping from GovInfo Bill Status files (client.ts) to the shapes the
 * central pipeline stores and ingests. No I/O: ids come in from the caller.
 *
 * A full read turns every file in the zips into a compact record (below), and
 * core stores that record for each bill, not the file. The record is enough to
 * keyword-match a bill, list it, and give it a status. A later ticket's ingest
 * downloads the full file again for a bill's sponsors, history, and texts.
 */

export const GOVINFO_STATE = 'US'
/** LegiScan's state_id for Congress, so these rows look like LegiScan's US rows everywhere. */
export const US_STATE_ID = 52

/**
 * Congress's bill types and what each becomes: LegiScan's number prefix, so a
 * cutover matches bills one to one, our bill type, and the words congress.gov
 * puts in a bill's address. Congress's `HR` is a bill, while LegiScan's `HR`
 * is a House resolution, so `HRES` becomes `HR`.
 */
export const BILL_TYPE = {
  HR: { prefix: 'HB', type: 'B', typeId: '1', slug: 'house-bill', origin: 'H' },
  S: { prefix: 'SB', type: 'B', typeId: '1', slug: 'senate-bill', origin: 'S' },
  HRES: { prefix: 'HR', type: 'R', typeId: '2', slug: 'house-resolution', origin: 'H' },
  SRES: { prefix: 'SR', type: 'R', typeId: '2', slug: 'senate-resolution', origin: 'S' },
  HJRES: { prefix: 'HJR', type: 'JR', typeId: '4', slug: 'house-joint-resolution', origin: 'H' },
  SJRES: { prefix: 'SJR', type: 'JR', typeId: '4', slug: 'senate-joint-resolution', origin: 'S' },
  HCONRES: { prefix: 'HCR', type: 'CR', typeId: '3', slug: 'house-concurrent-resolution', origin: 'H' },
  SCONRES: { prefix: 'SCR', type: 'CR', typeId: '3', slug: 'senate-concurrent-resolution', origin: 'S' },
} as const

export type CongressBillType = keyof typeof BILL_TYPE

/**
 * What central keeps for each bill, as the full read builds it. Every field
 * comes from one Bill Status file. `status` is a code of the vocabulary.
 */
export interface GovInfoRecord {
  congress: number
  /** The type as Congress writes it: HR, S, HRES, SRES, HJRES, SJRES, HCONRES, SCONRES. */
  type: CongressBillType
  /** The bill's number, without the type: "3132". */
  number: string
  /** The title Congress shows for the bill. */
  title: string
  /** The "Official Title as Introduced", which becomes the bill's description. */
  officialTitle: string
  introducedDate: string
  originChamber: 'H' | 'S'
  /** The chamber the bill is in now: the other one, once its own has passed it. */
  currentChamber: 'H' | 'S'
  status: number
  /** The date of the action that brought the bill to its status. */
  statusDate: string
  latestAction: { date: string; text: string } | null
  /** The bill's page on congress.gov. */
  url: string
  /**
   * When GovInfo built the zip the record came from, from its Last-Modified
   * header, or null when it sent none. GovInfo stamps every file in a zip with
   * the time it built the zip, so a file's own last change is only in the bulk
   * listing, and a pass between full reads takes it from there.
   */
  modified: string | null
}

/** The elements left out of a record's hash: a regenerated file restamps them with no change to the bill. */
const HASH_SKIPS = ['updateDate', 'updateDateIncludingText', 'dublinCore'] as const

const DATE = /^\d{4}-\d{2}-\d{2}$/

/** The file isn't Bill Status XML for the bill it should be. */
function invalid(file: string, why: string): Error {
  return new Error(`${file} isn't a valid Bill Status file: ${why}`)
}

/**
 * Read one Bill Status file: its compact record and its hash. `expected` is
 * the Congress and type of the zip it came from, which every file in the zip
 * must match.
 *
 * Fails closed: text that isn't XML, XML that isn't a Bill Status file, a file
 * missing a field the record needs, or a bill of another type or Congress
 * than its zip throws, so the pass writes nothing.
 *
 * The hash covers the file's text minus every `updateDate` and
 * `updateDateIncludingText` element and the Dublin Core block, so a
 * regeneration that only restamps them leaves it unchanged.
 */
export async function parseBillFile(
  name: string,
  xml: string,
  expected: { congress: number; type: CongressBillType },
  modified: string | null,
): Promise<{ record: GovInfoRecord; hash: string }> {
  let root: XmlNode
  let spans: [number, number][]
  try {
    ({ root, spans } = parseXml(xml, { spans: HASH_SKIPS }))
  } catch (err) {
    if (err instanceof XmlError) throw invalid(name, err.message)
    throw err
  }
  if (root.name !== 'billStatus') throw invalid(name, `its root is <${root.name}>, not <billStatus>`)
  const bill = child(root, 'bill')
  if (!bill) throw invalid(name, 'it has no <bill>')

  const type = childText(bill, 'type') as CongressBillType
  if (!Object.hasOwn(BILL_TYPE, type)) throw invalid(name, `its bill type "${type}" isn't one of Congress's eight`)
  if (type !== expected.type) throw invalid(name, `it is a ${type} in the ${expected.type} zip`)
  const congress = Number(childText(bill, 'congress'))
  if (congress !== expected.congress) throw invalid(name, `it is from Congress ${childText(bill, 'congress') || '(none)'}, not ${expected.congress}`)
  const number = childText(bill, 'number')
  if (!/^[1-9]\d*$/.test(number)) throw invalid(name, 'its bill has no number')
  const origin = childText(bill, 'originChamberCode')
  if (origin !== 'H' && origin !== 'S') throw invalid(name, `its origin chamber "${origin}" isn't H or S`)
  const introducedDate = childText(bill, 'introducedDate')
  if (!DATE.test(introducedDate)) throw invalid(name, 'its bill has no introduced date')
  const title = childText(bill, 'title')
  if (!title) throw invalid(name, 'its bill has no title')

  const derived = deriveStatus(bill, type)
  const official = child(bill, 'titles')?.children
    .find(t => childText(t, 'titleType') === 'Official Title as Introduced')
  const info = BILL_TYPE[type]
  // The newest action, which a bill without a latestAction element still has when it has actions.
  const latest = child(bill, 'latestAction') ?? child(bill, 'actions')?.children.find(a => a.name === 'item')
  const latestText = latest ? childText(latest, 'text') : ''
  const latestDate = latest ? childText(latest, 'actionDate') : ''

  const record: GovInfoRecord = {
    congress,
    type,
    number,
    title,
    officialTitle: (official && childText(official, 'title')) || title,
    introducedDate,
    originChamber: origin,
    currentChamber: currentChamber(type, origin, derived.passedHouse, derived.passedSenate),
    status: derived.status,
    statusDate: derived.date,
    latestAction: latestText && DATE.test(latestDate) ? { date: latestDate, text: latestText } : null,
    url: `https://www.congress.gov/bill/${congress}th-congress/${info.slug}/${number}`,
    modified,
  }
  // Every string read from the file is a slice of its text, and V8 keeps a slice's whole parent alive. A
  // JSON round trip copies each one, so a record holds its few hundred bytes and not the file it came from:
  // without the copy, the 19,690 records of a full read would hold all 248 MB of XML.
  return { record: JSON.parse(JSON.stringify(record)) as GovInfoRecord, hash: await hashWithout(xml, spans) }
}

/** The chamber a bill is in: its origin's, until the origin has passed it, then the other. A simple resolution stays where it began. */
function currentChamber(type: CongressBillType, origin: 'H' | 'S', passedHouse: boolean, passedSenate: boolean): 'H' | 'S' {
  if (type === 'HRES' || type === 'SRES') return origin
  const originPassed = origin === 'H' ? passedHouse : passedSenate
  if (!originPassed) return origin
  return origin === 'H' ? 'S' : 'H'
}

/** The SHA-256 of a file's text with these spans taken out. */
function hashWithout(xml: string, spans: readonly [number, number][]): Promise<string> {
  if (spans.length === 0) return sha256Hex(xml)
  let out = ''
  let at = 0
  for (const [start, end] of [...spans].sort((a, b) => a[0] - b[0])) {
    // A span inside one already taken out (an updateDate inside a skipped block) is already gone.
    if (start < at) continue
    out += xml.slice(at, start)
    at = end
  }
  return sha256Hex(out + xml.slice(at))
}

/** The bill's key in provider_ids and provider_records: "119/HR3132". */
export function govinfoNativeKey(congress: number, type: string, number: string): string {
  return `${congress}/${type}${number}`
}

/** LegiScan's number for a Congress bill: HR 3132 is "HB3132", HRES 492 is "HR492". */
export function legiscanNumber(r: Pick<GovInfoRecord, 'type' | 'number'>): string {
  return `${BILL_TYPE[r.type].prefix}${r.number}`
}

/** "119" → "119th Congress", "121" → "121st Congress". */
export function congressName(congress: number): string {
  const tens = congress % 100
  const suffix = tens >= 11 && tens <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[congress % 10] ?? 'th'
  return `${congress}${suffix} Congress`
}

/**
 * The Congress in session on a date. A Congress begins at noon on January 3
 * of an odd year and runs two years, so the 119th ran from January 3, 2025,
 * and January 1 or 2 of an odd year is still the Congress before.
 */
export function congressOn(today: string): { congress: number; yearStart: number; yearEnd: number } {
  const year = Number(today.slice(0, 4))
  const monthDay = today.slice(5, 10)
  const startYear = year % 2 === 1
    ? (monthDay < '01-03' ? year - 2 : year)
    : year - 1
  return { congress: (startYear - 1789) / 2 + 1, yearStart: startYear, yearEnd: startYear + 1 }
}

/** The full-pass entry for one record: enough to keyword-match it, and its change hash. */
export function toGovInfoEntry(r: GovInfoRecord, billId: number, hash: string): SyncEntry {
  return {
    bill_id: billId,
    number: legiscanNumber(r),
    change_hash: hash,
    title: r.title,
    description: r.officialTitle,
    status: r.status,
    status_date: r.statusDate,
    last_action: r.latestAction?.text,
    last_action_date: r.latestAction?.date,
    state_link: r.url,
    bill_type: BILL_TYPE[r.type].type,
  }
}

/**
 * One bill's measure, from its stored record alone. The ingest of sponsors,
 * history, committees, texts, and votes comes from the full file in a later
 * ticket; until then a bill carries what a full read learned.
 */
export function buildGovInfoMeasure(
  r: GovInfoRecord,
  billId: number,
  hash: string,
  session: CentralMeasure['session'],
): CentralMeasure {
  const info = BILL_TYPE[r.type]
  const bodyId = (c: 'H' | 'S') => (c === 'H' ? 1 : 2)
  return {
    bill_id: billId,
    bill_number: legiscanNumber(r),
    title: r.title,
    description: r.officialTitle,
    state: GOVINFO_STATE,
    state_id: US_STATE_ID,
    change_hash: hash,
    status: r.status,
    status_date: r.statusDate,
    bill_type: info.type,
    bill_type_id: info.typeId,
    body: r.originChamber,
    body_id: bodyId(r.originChamber),
    current_body: r.currentChamber,
    current_body_id: bodyId(r.currentChamber),
    url: '',
    state_link: r.url,
    pending_committee_id: 0,
    session_id: session.session_id,
    session,
    committee: null,
    referrals: [],
    progress: [],
    sponsors: [],
    history: r.latestAction
      ? [{ date: r.latestAction.date, action: r.latestAction.text, chamber: '', chamber_id: 0, importance: 2 }]
      : [],
    sasts: [],
    subjects: [],
    votes: [],
    texts: [],
    amendments: [],
    supplements: [],
    extras: {},
  }
}
