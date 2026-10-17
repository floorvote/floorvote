/**
 * Test helpers for GovInfo roll calls (#618): the House Clerk's and the
 * Senate's recorded roll call files, senate.gov's `cvc_member_data.xml`, and
 * the congress-legislators historical file, as the stubbed network serves
 * them.
 *
 * Every file under test/fixtures/govinfo/rollcalls is a real file, recorded on
 * October 17, 2026, with its member list cut down to a couple dozen members
 * (every vote, tally, and question the file recorded is kept, so a file's
 * tally is larger than the members it lists, as the real one's is). The bills
 * that link them are in rollcalls/bills.
 */

const rollCalls = import.meta.glob('../fixtures/govinfo/rollcalls/*.xml', { query: '?raw', import: 'default', eager: true }) as Record<string, string>
const billFiles = import.meta.glob('../fixtures/govinfo/rollcalls/bills/BILLSTATUS-*.xml', { query: '?raw', import: 'default', eager: true }) as Record<string, string>
const cvc = import.meta.glob('../fixtures/govinfo/rollcalls/members/cvc_member_data.xml', { query: '?raw', import: 'default', eager: true }) as Record<string, string>
const historical = import.meta.glob('../fixtures/govinfo/rollcalls/members/legislators-historical.csv', { query: '?raw', import: 'default', eager: true }) as Record<string, string>

const base = (path: string) => path.split('/').pop()!

/** The bills the roll call tests add to the recorded set, by file name. */
export const rollCallBillFiles: ReadonlyMap<string, string> = new Map(Object.entries(billFiles).map(([p, x]) => [base(p), x]))

/** senate.gov's list of sitting senators, trimmed to the ones the recorded Senate votes name, and without the four who left the 119th Congress. */
export const CVC_URL = 'https://www.senate.gov/legislative/LIS_MEMBER/cvc_member_data.xml'
export const cvcFile: string = Object.values(cvc)[0]

/** congress-legislators' historical file, trimmed to a few members and the four senators who left the 119th Congress. */
export const HISTORICAL_URL = 'https://unitedstates.github.io/congress-legislators/legislators-historical.csv'
export const historicalFile: string = Object.values(historical)[0]

export const HOUSE_ROLL_URL = /^https:\/\/clerk\.house\.gov\/evs\/(\d{4})\/roll(\d{3,4})\.xml$/
export const SENATE_ROLL_URL = /^https:\/\/www\.senate\.gov\/legislative\/LIS\/roll_call_votes\/vote(\d{3})(\d)\/vote_\d{3}_\d_(\d{5})\.xml$/

/** The recorded roll call files, by the file name `rollCallFileName` gives each address. */
export const rollCallFiles: ReadonlyMap<string, string> = new Map(Object.entries(rollCalls).map(([p, x]) => [base(p), x]))

/** `house-2026-roll009.xml` for the Clerk's `.../evs/2026/roll009.xml`, and `senate-119-2-00082.xml` for the Senate's vote 82 of the 119th Congress's second session. */
export function rollCallFileName(url: string): string | null {
  const house = HOUSE_ROLL_URL.exec(url)
  if (house) return `house-${house[1]}-roll${house[2]}.xml`
  const senate = SENATE_ROLL_URL.exec(url)
  if (senate) return `senate-${senate[1]}-${senate[2]}-${senate[3]}.xml`
  return null
}

/** The Clerk's address of a House roll call. */
export const houseUrl = (year: number, roll: number) => `https://clerk.house.gov/evs/${year}/roll${String(roll).padStart(3, '0')}.xml`

/** The Senate's address of a roll call vote. */
export const senateUrl = (congress: number, session: number, roll: number) =>
  `https://www.senate.gov/legislative/LIS/roll_call_votes/vote${congress}${session}/vote_${congress}_${session}_${String(roll).padStart(5, '0')}.xml`

/** The recorded files, as a test's network serves them: a map to add to or change, by address. */
export function rollCallNetwork(): Map<string, () => Response> {
  const served = new Map<string, () => Response>()
  for (const name of rollCallFiles.keys()) {
    const m = /^house-(\d{4})-roll(\d{3,4})\.xml$/.exec(name)
    const s = /^senate-(\d{3})-(\d)-(\d{5})\.xml$/.exec(name)
    const url = m ? houseUrl(Number(m[1]), Number(m[2])) : s ? senateUrl(Number(s[1]), Number(s[2]), Number(s[3])) : null
    if (url) served.set(url, () => new Response(rollCallFiles.get(name)!, { status: 200, headers: { 'content-type': 'application/xml' } }))
  }
  served.set(CVC_URL, () => new Response(cvcFile, { status: 200, headers: { 'content-type': 'application/xml' } }))
  served.set(HISTORICAL_URL, () => new Response(historicalFile, { status: 200, headers: { 'content-type': 'text/csv' } }))
  return served
}

/** Whether an address is one of the files `rollCallNetwork` serves. */
export const isRollCallHost = (url: string) =>
  HOUSE_ROLL_URL.test(url) || SENATE_ROLL_URL.test(url) || url === CVC_URL || url === HISTORICAL_URL
