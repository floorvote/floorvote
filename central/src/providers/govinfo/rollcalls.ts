import { invalidBillFile, type GovInfoRecord } from './map'
import { actionItems, child, childText } from './status'
import { parseXml, XmlError, type XmlNode } from './xml'

/**
 * Pure readers for the roll calls a Bill Status file links (#618): the
 * recorded votes in a bill's actions, the House Clerk's and the Senate's roll
 * call files, senate.gov's member list, and congress-legislators' historical
 * file. No I/O: client.ts fetches, and each reader throws on anything that
 * isn't the file shape it reads, so an ingest fails closed.
 *
 * A roll call file is read for what it records: the question put, the result,
 * the tally, and each member's vote. The House names its voters by Bioguide
 * id, so they are the people #617 minted for sponsors. The Senate names its
 * members by LIS id, which senate.gov's member list and congress-legislators'
 * historical file map to Bioguide ids.
 */

export interface RecordedVote {
  chamber: 'H' | 'S'
  congress: number
  /** 1 or 2: the Congress's first or second session. */
  session: number
  roll: number
  /** The roll call file's address, always the Clerk's or the Senate's own. */
  url: string
}

/** The four words a member's vote is served as. "Aye" is Yea and "No" is Nay. */
export type VoteWord = 'Yea' | 'Nay' | 'Not Voting' | 'Present'

export interface Voter {
  /** A House voter's Bioguide id, or a Senate voter's LIS id. */
  key: string
  /** The name the file prints: the Clerk's last name (with the state when two members share one), and the Senate's first and last. */
  name: string
  firstName: string
  lastName: string
  party: string
  state: string
  vote: VoteWord
}

export interface RollCall extends RecordedVote {
  /** The day of the vote, YYYY-MM-DD. */
  date: string
  /** The question put: "On Passage", "On the Motion to Table", and so on, with the amendment named when the vote was on one. */
  question: string
  /** The result the chamber recorded, which a count alone doesn't give (a veto override needs two-thirds, a cloture motion three-fifths). */
  passed: boolean
  yea: number
  nay: number
  /** Not voting, and "Present", which counts with it. */
  nv: number
  /** The Senate's absent count. The House has none. */
  absent: number
  voters: Voter[]
}

const BIOGUIDE = /^[A-Z]\d{6}$/
const LIS_ID = /^S\d+$/
const STATE = /^[A-Z]{2}$/
const COUNT = /^\d+$/

const HOUSE_URL = /^https:\/\/clerk\.house\.gov\/evs\/(\d{4})\/roll(\d{3,4})\.xml$/
const SENATE_URL = /^https:\/\/www\.senate\.gov\/legislative\/LIS\/roll_call_votes\/vote(\d{3})(\d)\/vote_(\d{3})_(\d)_(\d{5})\.xml$/

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

// ---- The recorded votes of a bill's actions

/**
 * The roll calls a bill's own actions link, oldest action first, each once:
 * the House floor and the Library of Congress each record a vote, in two
 * actions, and a bill's votes on an amendment sit in its amendments, which the
 * provider leaves out.
 *
 * Fails closed, and before anything is fetched: an address is followed only
 * if it is the Clerk's or the Senate's own for the roll call the vote's fields
 * name, so a bill file that says otherwise can't point the ingest at another
 * host or another vote.
 */
export function readRecordedVotes(file: string, bill: XmlNode, record: Pick<GovInfoRecord, 'congress'>): RecordedVote[] {
  const found = new Map<string, RecordedVote>()
  // The feed lists a bill's newest action first (detail.ts reads it the same way).
  for (const action of actionItems(bill).reverse()) {
    for (const v of child(action, 'recordedVotes')?.children.filter(c => c.name === 'recordedVote') ?? []) {
      const vote = readRecordedVote(file, v, record.congress)
      const key = `${vote.chamber}/${vote.congress}/${vote.session}/${vote.roll}`
      const seen = found.get(key)
      if (seen && seen.url !== vote.url) throw invalidBillFile(file, `roll call ${key} is linked at two addresses (${seen.url} and ${vote.url})`)
      if (!seen) found.set(key, vote)
    }
  }
  return [...found.values()]
}

function readRecordedVote(file: string, v: XmlNode, billCongress: number): RecordedVote {
  const chamberName = childText(v, 'chamber')
  const chamber = chamberName === 'House' ? 'H' : chamberName === 'Senate' ? 'S' : null
  if (!chamber) throw invalidBillFile(file, `a recorded vote is in "${chamberName}", not the House or Senate`)
  const congress = childText(v, 'congress')
  if (Number(congress) !== billCongress) throw invalidBillFile(file, `a recorded vote is of Congress ${congress || '(none)'}, not ${billCongress}`)
  const session = childText(v, 'sessionNumber')
  if (session !== '1' && session !== '2') throw invalidBillFile(file, `a recorded vote is of session "${session}", not 1 or 2`)
  const rollText = childText(v, 'rollNumber')
  if (!/^[1-9]\d*$/.test(rollText)) throw invalidBillFile(file, `a recorded vote has a roll number that isn't one ("${rollText}")`)
  const roll = Number(rollText)
  const url = childText(v, 'url')

  const addressed = chamber === 'H' ? HOUSE_URL.exec(url) : SENATE_URL.exec(url)
  if (!addressed) throw invalidBillFile(file, `roll call ${rollText} links "${url || '(no address)'}", which isn't the ${chamber === 'H' ? 'House Clerk' : 'Senate'}'s address for a roll call`)
  if (chamber === 'H') {
    // A Congress's first session is the odd year it begins, and the second is the next.
    const year = 2 * billCongress + 1787 + (session === '2' ? 1 : 0)
    if (Number(addressed[2]) !== roll || Number(addressed[1]) !== year) {
      throw invalidBillFile(file, `roll call ${rollText} of session ${session} links "${url}", which is for another vote`)
    }
  } else if (Number(addressed[1]) !== billCongress || addressed[2] !== session || Number(addressed[3]) !== billCongress || addressed[4] !== session || Number(addressed[5]) !== roll) {
    throw invalidBillFile(file, `roll call ${rollText} of session ${session} links "${url}", which is for another vote`)
  }
  return { chamber, congress: billCongress, session: Number(session), roll, url }
}

// ---- Vote words and results

const VOTE_WORD: Record<string, VoteWord> = {
  Yea: 'Yea', Aye: 'Yea', Nay: 'Nay', No: 'Nay', 'Not Voting': 'Not Voting', Present: 'Present',
}

function voteWord(file: string, who: string, raw: string): VoteWord {
  const word = Object.hasOwn(VOTE_WORD, raw) ? VOTE_WORD[raw] : undefined
  if (!word) throw invalidRollCall(file, `${who} voted "${raw}", which isn't Yea, Aye, Nay, No, Not Voting, or Present`)
  return word
}

/**
 * Results that say a question was turned down. Checked first, since several hold a word that
 * says the opposite: "Not Sustained" and "Veto Sustained" hold "Sustained", "Not Germane" holds
 * "Germane", and "Not Invoked" holds "Invoked". A Senate vote to override a veto is "Veto
 * Sustained" when the override fails (the veto stands) and "Veto Overridden" when it succeeds.
 */
const TURNED_DOWN = /\b(rejected|defeated|failed|not sustained|veto sustained|not well taken|not germane|not invoked|not agreed to)\b/i
/** Results that say it was carried. */
const CARRIED = /\b(agreed to|passed|sustained|overridden|well taken|germane|invoked|confirmed|adopted|concurred)\b/i

/**
 * Whether a chamber carried the question, from the result it wrote ("Passed",
 * "Motion to Table Rejected", "Cloture Motion Agreed to"). A result that
 * neither carries nor turns it down throws: a "pass" or "fail" shown beside a
 * vote shouldn't be a guess.
 */
function carried(file: string, result: string): boolean {
  if (TURNED_DOWN.test(result)) return false
  if (CARRIED.test(result)) return true
  throw invalidRollCall(file, `its result "${result || '(none)'}" doesn't say whether the question was carried`)
}

export function invalidRollCall(file: string, why: string): Error {
  return new Error(`${file} isn't a valid roll call file: ${why}`)
}

function parseRoot(file: string, xml: string, rootName: string): XmlNode {
  let root: XmlNode
  try {
    ({ root } = parseXml(xml))
  } catch (err) {
    if (err instanceof XmlError) throw invalidRollCall(file, err.message)
    throw err
  }
  if (root.name !== rootName) throw invalidRollCall(file, `its root is <${root.name}>, not <${rootName}>`)
  return root
}

function count(file: string, node: XmlNode | undefined, name: string, opts: { optional?: boolean } = {}): number {
  const text = node ? childText(node, name) : ''
  if (text === '' && opts.optional) return 0
  if (!COUNT.test(text)) throw invalidRollCall(file, `its ${name} is "${text}", not a count`)
  return Number(text)
}

/** A date written with a month name, as YYYY-MM-DD. Throws for a day that isn't one. */
function isoDate(file: string, what: string, year: number, month: number, day: number): string {
  const d = new Date(Date.UTC(year, month - 1, day))
  if (month < 1 || month > 12 || d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
    throw invalidRollCall(file, `its ${what} isn't a date`)
  }
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

// ---- House Clerk roll call files

/** `clerk.house.gov/evs/2026/roll009.xml`: a `rollcall-vote` of a `vote-metadata` block and the `vote-data` of each member's vote. */
export function parseHouseRollCall(file: string, xml: string, expected: RecordedVote): RollCall {
  const root = parseRoot(file, xml, 'rollcall-vote')
  const meta = child(root, 'vote-metadata')
  const data = child(root, 'vote-data')
  if (!meta) throw invalidRollCall(file, 'it has no <vote-metadata>')
  if (!data) throw invalidRollCall(file, 'it has no <vote-data>')

  const sessionText = childText(meta, 'session')
  const session = sessionText === '1st' ? 1 : sessionText === '2nd' ? 2 : undefined
  if (Number(childText(meta, 'congress')) !== expected.congress || session !== expected.session || childText(meta, 'rollcall-num') !== String(expected.roll)) {
    throw invalidRollCall(file, `it is roll call ${childText(meta, 'rollcall-num') || '(none)'} of the ${childText(meta, 'session') || '(no)'} session of Congress ${childText(meta, 'congress') || '(none)'}, not roll call ${expected.roll} of session ${expected.session} of Congress ${expected.congress}`)
  }

  const questionText = childText(meta, 'vote-question')
  if (!questionText) throw invalidRollCall(file, 'it has no vote-question')
  // A vote on an amendment names it, so it reads differently from a vote on passage.
  const amendment = childText(meta, 'amendment-author') || (childText(meta, 'amendment-num') && `amendment ${childText(meta, 'amendment-num')}`)
  const question = amendment ? `${questionText} (${amendment})` : questionText

  const when = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(childText(meta, 'action-date'))
  const month = when ? MONTHS.findIndex(m => m.slice(0, 3) === when[2]) + 1 : 0
  if (!when || month === 0) throw invalidRollCall(file, `its action-date ("${childText(meta, 'action-date')}") isn't a day-month-year date`)
  const date = isoDate(file, 'action-date', Number(when[3]), month, Number(when[1]))

  const passed = carried(file, childText(meta, 'vote-result'))

  const totals = child(child(meta, 'vote-totals') ?? meta, 'totals-by-vote')
  if (!totals) throw invalidRollCall(file, 'it has no totals-by-vote')
  const yea = count(file, totals, 'yea-total')
  const nay = count(file, totals, 'nay-total')
  const present = count(file, totals, 'present-total')
  const notVoting = count(file, totals, 'not-voting-total')

  const voters: Voter[] = []
  const seen = new Set<string>()
  for (const rv of data.children.filter(c => c.name === 'recorded-vote')) {
    const who = child(rv, 'legislator')
    if (!who) throw invalidRollCall(file, 'a recorded vote has no legislator')
    const key = who.attrs['name-id'] ?? ''
    if (!BIOGUIDE.test(key)) throw invalidRollCall(file, `a voter's name-id ("${key}") isn't a Bioguide id`)
    if (seen.has(key)) throw invalidRollCall(file, `${key} votes twice`)
    seen.add(key)
    const name = who.text.trim()
    if (!name) throw invalidRollCall(file, `voter ${key} has no name`)
    const state = who.attrs.state ?? ''
    if (!STATE.test(state)) throw invalidRollCall(file, `voter ${key} has a state ("${state}") that isn't one`)
    voters.push({
      key,
      name,
      firstName: '',
      // The Clerk adds the state in parentheses when two members share a last name: "Clarke (NY)".
      lastName: name.replace(/ \([A-Z]{2}\)$/, ''),
      party: who.attrs.party ?? '',
      state,
      vote: voteWord(file, key, childText(rv, 'vote')),
    })
  }
  if (voters.length === 0) throw invalidRollCall(file, 'it records no votes')

  return { ...expected, date, question, passed, yea, nay, nv: notVoting + present, absent: 0, voters }
}

// ---- Senate roll call files

/** `senate.gov/legislative/LIS/roll_call_votes/vote1192/vote_119_2_00082.xml`: a `roll_call_vote` with its question, result, count, and `members`. */
export function parseSenateRollCall(file: string, xml: string, expected: RecordedVote): RollCall {
  const root = parseRoot(file, xml, 'roll_call_vote')
  if (Number(childText(root, 'congress')) !== expected.congress || childText(root, 'session') !== String(expected.session) || childText(root, 'vote_number') !== String(expected.roll)) {
    throw invalidRollCall(file, `it is vote ${childText(root, 'vote_number') || '(none)'} of session ${childText(root, 'session') || '(none)'} of Congress ${childText(root, 'congress') || '(none)'}, not vote ${expected.roll} of session ${expected.session} of Congress ${expected.congress}`)
  }

  const question = childText(root, 'vote_question_text') || childText(root, 'question')
  if (!question) throw invalidRollCall(file, 'it has no question')

  const when = /^([A-Za-z]+) (\d{1,2}), (\d{4})/.exec(childText(root, 'vote_date'))
  const month = when ? MONTHS.indexOf(when[1]) + 1 : 0
  if (!when || month === 0) throw invalidRollCall(file, `its vote_date ("${childText(root, 'vote_date')}") isn't a date`)
  const date = isoDate(file, 'vote_date', Number(when[3]), month, Number(when[2]))

  const passed = carried(file, childText(root, 'vote_result'))

  const tally = child(root, 'count')
  if (!tally) throw invalidRollCall(file, 'it has no count')
  const yea = count(file, tally, 'yeas')
  const nay = count(file, tally, 'nays')
  const present = count(file, tally, 'present', { optional: true })
  const absent = count(file, tally, 'absent', { optional: true })

  const voters: Voter[] = []
  const seen = new Set<string>()
  for (const m of child(root, 'members')?.children.filter(c => c.name === 'member') ?? []) {
    const key = childText(m, 'lis_member_id')
    if (!LIS_ID.test(key)) throw invalidRollCall(file, `a member's lis_member_id ("${key}") isn't a LIS id`)
    if (seen.has(key)) throw invalidRollCall(file, `${key} votes twice`)
    seen.add(key)
    const lastName = childText(m, 'last_name')
    if (!lastName) throw invalidRollCall(file, `member ${key} has no last name`)
    const state = childText(m, 'state')
    if (!STATE.test(state)) throw invalidRollCall(file, `member ${key} has a state ("${state}") that isn't one`)
    const firstName = childText(m, 'first_name')
    voters.push({
      key,
      name: [firstName, lastName].filter(Boolean).join(' '),
      firstName,
      lastName,
      party: childText(m, 'party'),
      state,
      vote: voteWord(file, key, childText(m, 'vote_cast')),
    })
  }
  if (voters.length === 0) throw invalidRollCall(file, 'it records no votes')

  return { ...expected, date, question, passed, yea, nay, nv: present, absent, voters }
}

// ---- Who a Senate LIS id is

/** senate.gov's `cvc_member_data.xml`: each sitting senator's LIS id (an attribute) and Bioguide id, by LIS id. */
export function parseSenateMembers(xml: string): Map<string, string> {
  const file = 'senate.gov\'s cvc_member_data.xml'
  let root: XmlNode
  try {
    ({ root } = parseXml(xml))
  } catch (err) {
    if (err instanceof XmlError) throw new Error(`${file} isn't valid: ${err.message}`)
    throw err
  }
  if (root.name !== 'senators') throw new Error(`${file} isn't valid: its root is <${root.name}>, not <senators>`)
  const senators = root.children.filter(c => c.name === 'senator')
  if (senators.length === 0) throw new Error(`${file} isn't valid: it lists no senators`)
  const map = new Map<string, string>()
  const listed = new Set<string>()
  for (const s of senators) {
    const lis = s.attrs.lis_member_id ?? ''
    if (!LIS_ID.test(lis)) throw new Error(`${file} isn't valid: a senator's lis_member_id ("${lis}") isn't a LIS id`)
    if (listed.has(lis)) throw new Error(`${file} isn't valid: ${lis} is listed twice`)
    listed.add(lis)
    const bioguide = childText(s, 'bioguideId')
    // A senator with no Bioguide id is left out, so the historical file can answer for them.
    if (bioguide === '') continue
    if (!BIOGUIDE.test(bioguide)) throw new Error(`${file} isn't valid: ${lis}'s bioguideId ("${bioguide}") isn't a Bioguide id`)
    map.set(lis, bioguide)
  }
  return map
}

/**
 * congress-legislators' `legislators-historical.csv`: a row for each legislator
 * who has left Congress, with `lis_id` set for senators from the 1990s on.
 * The CSV is read rather than the JSON of the same name: 1.5 MB against 13 MB,
 * with the two columns this needs.
 */
export function parseHistoricalMembers(csv: string): Map<string, string> {
  const file = 'congress-legislators\' legislators-historical.csv'
  const rows = parseCsv(file, csv)
  const header = rows[0] ?? []
  const lisAt = header.indexOf('lis_id')
  const bioguideAt = header.indexOf('bioguide_id')
  if (lisAt < 0 || bioguideAt < 0) throw new Error(`${file} isn't valid: it has no ${lisAt < 0 ? 'lis_id' : 'bioguide_id'} column`)
  const map = new Map<string, string>()
  for (const [i, row] of rows.slice(1).entries()) {
    if (row.length !== header.length) throw new Error(`${file} isn't valid: row ${i + 2} has ${row.length} fields, not ${header.length}`)
    const lis = row[lisAt]
    if (lis === '') continue
    if (!LIS_ID.test(lis)) throw new Error(`${file} isn't valid: row ${i + 2} has a lis_id ("${lis}") that isn't a LIS id`)
    const bioguide = row[bioguideAt]
    if (!BIOGUIDE.test(bioguide)) throw new Error(`${file} isn't valid: ${lis} has a bioguide_id ("${bioguide}") that isn't a Bioguide id`)
    const known = map.get(lis)
    if (known !== undefined && known !== bioguide) throw new Error(`${file} isn't valid: ${lis} belongs to both ${known} and ${bioguide}`)
    map.set(lis, bioguide)
  }
  if (map.size === 0) throw new Error(`${file} isn't valid: it lists no senators`)
  return map
}

/** RFC 4180 CSV: quoted fields with commas, doubled quotes, and line breaks, CRLF or LF, and an optional byte order mark. */
function parseCsv(file: string, text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let i = text.charCodeAt(0) === 0xFEFF ? 1 : 0
  const n = text.length
  // Whether the current field has begun, so an opening quote is only one at a field's start.
  let started = false
  while (i < n) {
    const c = text[i]
    if (c === '"' && !started) {
      // A quoted field, to its closing quote.
      started = true
      i++
      for (;;) {
        if (i >= n) throw new Error(`${file} isn't valid: a quoted field never ends`)
        if (text[i] === '"') {
          if (text[i + 1] === '"') { field += '"'; i += 2; continue }
          i++
          break
        }
        field += text[i++]
      }
      const next = text[i]
      if (i < n && next !== ',' && next !== '\n' && next !== '\r') throw new Error(`${file} isn't valid: text follows a closing quote`)
    } else if (c === ',') {
      row.push(field); field = ''; started = false; i++
    } else if (c === '\n' || c === '\r') {
      row.push(field); field = ''; started = false
      if (c === '\r' && text[i + 1] === '\n') i++
      i++
      // A blank line is no row.
      if (row.length > 1 || row[0] !== '') rows.push(row)
      row = []
    } else {
      field += c; started = true; i++
    }
  }
  if (field !== '' || started || row.length > 0) {
    row.push(field)
    if (row.length > 1 || row[0] !== '') rows.push(row)
  }
  return rows
}
