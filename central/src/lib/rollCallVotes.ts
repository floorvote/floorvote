import { sql } from 'drizzle-orm'
import type { Db } from '../types'

/** One legislator's vote on a roll call, keyed by central person id. */
export type MemberVote = { peopleId: number; voteId: number | null; voteText: string | null }
export type RollCallMemberVotes = { rollCallId: number; votes: MemberVote[] }

/**
 * Cap on one statement's JSON parameter. D1 caps a statement at 100 KB and a
 * bound value at 2 MB. Staying under the smaller one holds even if bound values
 * count toward the statement, and is about 2,500 votes per statement.
 */
const MAX_JSON_CHARS = 60_000

/**
 * Every roll call central has for a session's bills, with how many member votes
 * it stores (0 when none). One statement, whatever the session's size.
 */
export async function storedVoteCounts(db: Db, sessionId: number): Promise<Map<number, number>> {
  const rows = await db.all<{ roll_call_id: number; n: number }>(sql`
    SELECT rc.roll_call_id,
           (SELECT COUNT(*) FROM roll_call_votes v WHERE v.roll_call_id = rc.roll_call_id) AS n
    FROM roll_calls rc JOIN bills b ON b.bill_id = rc.bill_id
    WHERE b.session_id = ${sessionId}`)
  return new Map(rows.map(r => [r.roll_call_id, r.n]))
}

/**
 * Write the member votes of each given roll call. The one write path for
 * `roll_call_votes`: the weekly vote-dataset load uses it, and so should any
 * provider whose bill feed carries per-member votes.
 *
 * With `replace`, each roll call's stored votes are deleted first. Callers that
 * know a roll call has none skip that statement.
 *
 * Each statement carries many roll calls' votes as one JSON parameter, so a
 * session's worth fits in a few hundred statements instead of one per vote. A
 * roll call never spans two statements, and everything runs in one batch (a
 * transaction), so no roll call is ever left half written. Row ids are
 * `<roll_call_id>-<people_id>`, the same as the bulk seeder's, so a seeder
 * backfill and this write never duplicate each other.
 *
 * Returns how many statements ran.
 */
export async function writeMemberVotes(
  d1: D1Database,
  rollCalls: RollCallMemberVotes[],
  { replace }: { replace: boolean },
): Promise<number> {
  const groups: { ids: number[]; rows: unknown[][]; chars: number }[] = []
  for (const rc of rollCalls) {
    if (rc.votes.length === 0) continue
    const rows = rc.votes.map(v => [rc.rollCallId, v.peopleId, v.voteId, v.voteText])
    const chars = JSON.stringify(rows).length
    let group = groups.at(-1)
    if (!group || group.chars + chars > MAX_JSON_CHARS) {
      group = { ids: [], rows: [], chars: 0 }
      groups.push(group)
    }
    group.ids.push(rc.rollCallId)
    group.rows.push(...rows)
    group.chars += chars
  }
  if (groups.length === 0) return 0

  // Raw D1 statements, since drizzle's batch() takes query builders, not raw SQL.
  const remove = d1.prepare(`
    DELETE FROM roll_call_votes
    WHERE roll_call_id IN (SELECT value FROM json_each(?))`)
  const insert = d1.prepare(`
    INSERT OR REPLACE INTO roll_call_votes (id, roll_call_id, people_id, vote_id, vote_text)
    SELECT json_extract(value, '$[0]') || '-' || json_extract(value, '$[1]'),
           json_extract(value, '$[0]'), json_extract(value, '$[1]'),
           json_extract(value, '$[2]'), json_extract(value, '$[3]')
    FROM json_each(?)`)
  const stmts = groups.flatMap(g => [
    ...(replace ? [remove.bind(JSON.stringify(g.ids))] : []),
    insert.bind(JSON.stringify(g.rows)),
  ])
  await d1.batch(stmts)
  return stmts.length
}
