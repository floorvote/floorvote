import type { XmlNode } from './xml'
import { GOVINFO_STATUS_BASE } from './vocabulary'

/**
 * A bill's status, derived from the structured fields of its Bill Status file
 * and never from an action's text. The rules are the Status table in the
 * GovInfo spec (#612), which the vocabulary's labels follow.
 *
 * Actions are applied oldest first, and a later event wins, with three
 * guards:
 * - a bill never moves back along its path (introduced, in committee,
 *   reported, passed a chamber, passed both, presented to the President,
 *   vetoed, law), so a Senate committee's referral of a House bill that has
 *   passed the House leaves it at Passed House;
 * - Failed, which isn't on the path, applies only while the bill hasn't passed
 *   a chamber, and a later referral, report, or passage moves it on;
 * - a law, or a resolution agreed to, is final.
 */

export const GOVINFO_STATUS = {
  introduced: GOVINFO_STATUS_BASE + 1,
  inCommittee: GOVINFO_STATUS_BASE + 2,
  reported: GOVINFO_STATUS_BASE + 3,
  passedHouse: GOVINFO_STATUS_BASE + 4,
  passedSenate: GOVINFO_STATUS_BASE + 5,
  passedBoth: GOVINFO_STATUS_BASE + 6,
  presented: GOVINFO_STATUS_BASE + 7,
  failed: GOVINFO_STATUS_BASE + 8,
  vetoed: GOVINFO_STATUS_BASE + 9,
  becameLaw: GOVINFO_STATUS_BASE + 10,
  agreedTo: GOVINFO_STATUS_BASE + 11,
} as const

/** Where each status sits on a bill's path. Failed sits below every step, so any later step moves a bill on from it. */
const PATH: Record<number, number> = {
  [GOVINFO_STATUS.failed]: 0,
  [GOVINFO_STATUS.introduced]: 1,
  [GOVINFO_STATUS.inCommittee]: 2,
  [GOVINFO_STATUS.reported]: 3,
  [GOVINFO_STATUS.passedHouse]: 4,
  [GOVINFO_STATUS.passedSenate]: 4,
  [GOVINFO_STATUS.passedBoth]: 5,
  [GOVINFO_STATUS.presented]: 6,
  [GOVINFO_STATUS.vetoed]: 7,
  [GOVINFO_STATUS.becameLaw]: 8,
  [GOVINFO_STATUS.agreedTo]: 8,
}

// The Library of Congress's action codes, and the House's own "E" codes that
// mirror them (https://www.govinfo.gov/bulkdata/BILLSTATUS/resources/BILLSTATUS-XML_User_User-Guide.pdf).
const REPORTED_CODES = new Set(['5000', '14000', '1010', '14900'])
/** A committee discharged from a measure. The discharge can be followed by a rejected motion to proceed, which only action text says. */
const DISCHARGE_CODES = new Set(['5500', '14500'])
const COMMITTEE_CODES = new Set(['2000', '11000', 'H11100'])
const PRESENTED_CODES = new Set(['28000', 'E20000'])
const FAILED_CODES = new Set(['9000', '18000', '33000'])
const LAW_CODES = new Set(['36000', 'E40000', '41000', 'E30000'])
const VETO_CODE = '31000'
const PASSED_HOUSE_CODE = '8000'
const PASSED_SENATE_CODE = '17000'

export interface DerivedStatus {
  status: number
  /** The date of the action that brought the bill to this status (YYYY-MM-DD). */
  date: string
  passedHouse: boolean
  passedSenate: boolean
}

/** The text of the first child of this name, or ''. */
export const childText = (node: XmlNode, name: string): string => node.children.find(c => c.name === name)?.text.trim() ?? ''
export const child = (node: XmlNode, name: string): XmlNode | undefined => node.children.find(c => c.name === name)

/** The bill's action items, in the order the feed lists them: newest first. */
export function actionItems(bill: XmlNode): XmlNode[] {
  return child(bill, 'actions')?.children.filter(c => c.name === 'item') ?? []
}

/**
 * Derive a bill's status. `bill` is the `bill` element, `type` its Congress
 * type (HR, S, HRES, SRES, HJRES, SJRES, HCONRES, SCONRES).
 */
export function deriveStatus(bill: XmlNode, type: string): DerivedStatus {
  const simple = type === 'HRES' || type === 'SRES'
  const concurrent = type === 'HCONRES' || type === 'SCONRES'
  // The feed lists a bill's newest action first, so oldest first is the list reversed.
  const actions = actionItems(bill).reverse().map(a => ({
    code: childText(a, 'actionCode'),
    type: childText(a, 'type'),
    date: childText(a, 'actionDate'),
    committee: child(a, 'committees')?.children.some(c => c.name === 'item') ?? false,
  }))
  // A veto is listed twice on its day, once with the code 31000 and once with E30000, the code for a signature.
  const vetoDates = new Set(actions.filter(a => a.code === VETO_CODE).map(a => a.date))

  let status: number = GOVINFO_STATUS.introduced
  let date = childText(bill, 'introducedDate')
  let passedHouse = false
  let passedSenate = false
  const set = (to: number, on: string) => { status = to; date = on }
  /** Move to a status only if it is further along the path than the one the bill is at. */
  const advance = (to: number, on: string) => { if (PATH[to] > PATH[status]) set(to, on) }

  for (const a of actions) {
    if (status === GOVINFO_STATUS.becameLaw || status === GOVINFO_STATUS.agreedTo) break
    if (LAW_CODES.has(a.code) && !(a.code === 'E30000' && vetoDates.has(a.date))) {
      set(GOVINFO_STATUS.becameLaw, a.date)
    } else if (a.code === VETO_CODE || a.type === 'Veto') {
      advance(GOVINFO_STATUS.vetoed, a.date)
    } else if (status === GOVINFO_STATUS.vetoed) {
      // Once vetoed, only becoming law moves a bill.
    } else if (a.code === PASSED_HOUSE_CODE || a.code === PASSED_SENATE_CODE) {
      const house = a.code === PASSED_HOUSE_CODE
      if (house) passedHouse = true
      else passedSenate = true
      if (simple) {
        // A simple resolution is done when its own chamber agrees to it.
        if (house === (type === 'HRES')) set(GOVINFO_STATUS.agreedTo, a.date)
      } else if (passedHouse && passedSenate) {
        if (concurrent) set(GOVINFO_STATUS.agreedTo, a.date)
        else advance(GOVINFO_STATUS.passedBoth, a.date)
      } else {
        advance(house ? GOVINFO_STATUS.passedHouse : GOVINFO_STATUS.passedSenate, a.date)
      }
    } else if (PRESENTED_CODES.has(a.code)) {
      advance(GOVINFO_STATUS.presented, a.date)
    } else if (FAILED_CODES.has(a.code)) {
      if (!passedHouse && !passedSenate) set(GOVINFO_STATUS.failed, a.date)
    } else if (REPORTED_CODES.has(a.code) || DISCHARGE_CODES.has(a.code)) {
      advance(GOVINFO_STATUS.reported, a.date)
    } else if (a.committee || a.type === 'Committee' || COMMITTEE_CODES.has(a.code)) {
      advance(GOVINFO_STATUS.inCommittee, a.date)
    }
  }

  // A law element is the Library of Congress saying the bill is a law, whatever its actions carry.
  const laws = child(bill, 'laws')
  if (status !== GOVINFO_STATUS.becameLaw && laws?.children.some(c => c.name === 'item')) {
    set(GOVINFO_STATUS.becameLaw, childText(child(bill, 'latestAction') ?? bill, 'actionDate') || date)
  }

  // A committee's own record of the referral, for a bill whose actions don't carry one.
  if (status === GOVINFO_STATUS.introduced) {
    for (const committee of child(bill, 'committees')?.children ?? []) {
      const referral = child(committee, 'activities')?.children
        .find(item => childText(item, 'name').toLowerCase() === 'referred to')
      if (referral) {
        set(GOVINFO_STATUS.inCommittee, childText(referral, 'date').slice(0, 10) || date)
        break
      }
    }
  }

  return { status, date, passedHouse, passedSenate }
}
