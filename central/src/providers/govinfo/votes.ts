import type { CentralMeasure, MeasurePerson } from '../sdk'
import { bioguideIdsOfSenators, fetchRollCall } from './client'
import type { RecordedVote, RollCall, Voter, VoteWord } from './rollcalls'
import { US_STATE_ID } from './map'

/**
 * A bill's roll calls, as the ingest writes them (#618): each linked roll call
 * read from its file (client.ts, rollcalls.ts), every voter named by a
 * Bioguide id, then turned into the bill's votes with ids from central's id
 * table. Like the rest of a bill's detail, it is two steps, so a bad file
 * mints nothing: `loadRollCalls` fetches and reads everything, and throws
 * before any id is asked for, and `resolveVotes` only turns keys into ids.
 */

export interface VotedRollCall {
  rollCall: RollCall
  /** Each voter with the Bioguide id their vote is under: a House voter's own, and a Senate voter's from the LIS id. */
  voters: (Voter & { bioguideId: string })[]
}

export interface VoteLoggers {
  roll(vote: RecordedVote): void
  members: () => void
  historical: () => void
}

/**
 * Read every roll call a bill links, and name every voter by Bioguide id.
 * A roll call shared by several bills of one ingest is fetched once (client.ts).
 * A Senate member the member list and the historical file both lack fails the
 * roll call closed (`bioguideIdsOfSenators`).
 */
export async function loadRollCalls(votes: readonly RecordedVote[], log: VoteLoggers): Promise<VotedRollCall[]> {
  const rolls: RollCall[] = []
  for (const vote of votes) rolls.push(await fetchRollCall(vote, () => log.roll(vote)))
  const senators = await bioguideIdsOfSenators(
    rolls.filter(r => r.chamber === 'S').flatMap(r => r.voters.map(v => v.key)),
    { members: log.members, historical: log.historical },
  )
  return rolls.map(rollCall => ({
    rollCall,
    voters: rollCall.voters.map(v => ({ ...v, bioguideId: rollCall.chamber === 'S' ? senators.get(v.key)! : v.key })),
  }))
}

/**
 * The key of a roll call in central's id table. A vote isn't unique to a bill,
 * since one vote can attach to several (a rule that brings up a package of
 * bills), and each bill's copy of it is a roll call of its own, so the key
 * carries the bill.
 */
export function rollCallKey(billKey: string, r: Pick<RollCall, 'chamber' | 'congress' | 'session' | 'roll'>): string {
  return `${r.chamber}/${r.congress}/${r.session}/${r.roll}/${billKey}`
}

/** The keys of a bill's roll calls that central mints an id for, by kind: each voter's Bioguide id, and each roll call's own key. */
export function voteKeys(billKey: string, rolls: readonly VotedRollCall[]): { person: string[]; rollcall: string[] } {
  return {
    person: [...new Set(rolls.flatMap(r => r.voters.map(v => v.bioguideId)))],
    rollcall: rolls.map(r => rollCallKey(billKey, r.rollCall)),
  }
}

/** LegiScan's vote ids: 1 Yea, 2 Nay, 3 not voting, 4 absent. */
const VOTE_ID = { Yea: 1, Nay: 2, Present: 3 } as const

/**
 * A member's vote as central stores it. "Present" is a way of not voting, so
 * it is "not voting" (id 3) with its own word kept. The Senate's "Not Voting"
 * is its absent count, so it is "absent" (id 4) with the Senate's word kept,
 * and the House's "Not Voting" is "not voting" (id 3).
 */
function memberVote(chamber: 'H' | 'S', vote: VoteWord): { vote_id: number; vote_text: string } {
  if (vote === 'Not Voting') return { vote_id: chamber === 'S' ? 4 : 3, vote_text: vote }
  return { vote_id: VOTE_ID[vote], vote_text: vote }
}

/** States whose members are delegates, who have no vote on the House floor but sign on to bills. */
const DELEGATE_STATES = new Set(['DC', 'PR', 'GU', 'VI', 'AS', 'MP'])

export interface VoteIds { person: Map<string, number>; rollcall: Map<string, number> }

/**
 * The bill's votes in the shape the ingest writes, and the people who voted,
 * for core to add where it has no row for them: the vote of a member nobody has
 * sponsored with still shows under their name, not their number. A voter is
 * named as the roll call file names them (the Clerk's last name, the Senate's
 * first and last), which a sponsor's record from the bill's own file only adds
 * to: core leaves an existing person alone.
 */
export function resolveVotes(billKey: string, rolls: readonly VotedRollCall[], ids: VoteIds): { votes: CentralMeasure['votes']; people: MeasurePerson[] } {
  const id = (kind: keyof VoteIds, key: string): number => {
    const found = ids[kind].get(key)
    if (found === undefined) throw new Error(`central minted no ${kind} id for ${key}`)
    return found
  }
  const people = new Map<string, MeasurePerson>()
  const votes: CentralMeasure['votes'] = rolls.map(({ rollCall: r, voters }) => {
    for (const v of voters) {
      if (people.has(v.bioguideId)) continue
      const senator = r.chamber === 'S'
      people.set(v.bioguideId, {
        people_id: id('person', v.bioguideId),
        name: v.name,
        party: v.party,
        role: senator ? 'Sen' : DELEGATE_STATES.has(v.state) ? 'Del' : 'Rep',
        role_id: senator ? 2 : 1,
        // A senator's district is their state, as a sponsor's is. The Clerk gives a House voter no district, so there is none to give.
        district: senator ? v.state : '',
        state_id: US_STATE_ID,
        ...(v.firstName ? { first_name: v.firstName } : {}),
        last_name: v.lastName,
        bioguide_id: v.bioguideId,
      })
    }
    return {
      roll_call_id: id('rollcall', rollCallKey(billKey, r)),
      date: r.date,
      desc: r.question,
      yea: r.yea,
      nay: r.nay,
      nv: r.nv,
      absent: r.absent,
      total: r.yea + r.nay + r.nv + r.absent,
      passed: r.passed ? 1 : 0,
      chamber: r.chamber,
      chamber_id: r.chamber === 'H' ? 1 : 2,
      url: '',
      state_link: r.url,
      member_votes: voters.map(v => ({ people_id: id('person', v.bioguideId), ...memberVote(r.chamber, v.vote) })),
    }
  })
  return { votes, people: [...people.values()] }
}
