import type { GovInfoRecord } from './map'
import type { XmlNode } from './xml'

export interface RecordedVote { chamber: 'H' | 'S'; congress: number; session: number; roll: number; url: string }
export type VoteWord = 'Yea' | 'Nay' | 'Not Voting' | 'Present'
export interface Voter { key: string; name: string; firstName: string; lastName: string; party: string; state: string; vote: VoteWord }
export interface RollCall {
  chamber: 'H' | 'S'; congress: number; session: number; roll: number; url: string
  date: string; question: string; passed: boolean
  yea: number; nay: number; nv: number; absent: number
  voters: Voter[]
}

const empty: RollCall = { chamber: 'H', congress: 0, session: 0, roll: 0, url: '', date: '', question: '', passed: false, yea: 0, nay: 0, nv: 0, absent: 0, voters: [] }

export function readRecordedVotes(_file: string, _bill: XmlNode, _record: GovInfoRecord): RecordedVote[] { return [] }
export function parseHouseRollCall(_name: string, _xml: string, _expected: RecordedVote): RollCall { return empty }
export function parseSenateRollCall(_name: string, _xml: string, _expected: RecordedVote): RollCall { return empty }
export function parseSenateMembers(_xml: string): Map<string, string> { return new Map() }
export function parseHistoricalMembers(_csv: string): Map<string, string> { return new Map() }
