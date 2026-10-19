import { env } from 'cloudflare:test'
import { describe, it, expect, beforeEach } from 'vitest'
import { deleteOtherRollCalls, knownRollCallIds, type StoredRollCall } from '../../src/lib/billRollCalls'
import type { CentralMeasure } from '../../src/providers'
import { clearDb } from '../helpers/migrations'

const stored = (rollCallId: number, over: Partial<StoredRollCall> = {}): StoredRollCall =>
  ({ rollCallId, date: '2026-03-03', description: 'Passed Senate (21-Y 19-N 0-A)', yea: 21, nay: 19, chamber: 'S', ...over })
const incoming = (roll_call_id: number, over: Partial<CentralMeasure['votes'][number]> = {}): CentralMeasure['votes'][number] =>
  ({ roll_call_id, date: '2026-03-03', desc: 'Passed Senate (21-Y 19-N 0-A)', yea: 21, nay: 19, nv: 0, absent: 0, total: 40, passed: 1, chamber: 'S', chamber_id: 0, url: '', state_link: '', ...over })

describe('knownRollCallIds', () => {
  it('knows every stored roll call, and a new one is not known', () => {
    expect(knownRollCallIds([stored(1), stored(2, { date: '2026-03-04' })], [incoming(1), incoming(3, { date: '2026-03-05' })]))
      .toEqual(new Set([1, 2]))
  })

  it('knows a roll call that only re-keys a stored one the measure no longer names', () => {
    // The same vote under a new id: the ingest replaces the stored row, so it is not a vote added.
    expect([...knownRollCallIds([stored(1)], [incoming(10)])].sort()).toEqual([1, 10])
  })

  it('matches each stored roll call to one incoming roll call, so a second vote with the same tally is new', () => {
    expect([...knownRollCallIds([stored(1)], [incoming(10), incoming(11)])].sort()).toEqual([1, 10])
  })

  it('does not match a stored roll call the measure still names', () => {
    // Roll call 1 stays, so 10 (the same tally on the same day) is a second vote, not a re-keyed one.
    expect([...knownRollCallIds([stored(1)], [incoming(1), incoming(10)])].sort()).toEqual([1])
  })

  it('does not match a different vote', () => {
    expect([...knownRollCallIds([stored(1)], [incoming(10, { yea: 22 })])].sort()).toEqual([1])
    expect([...knownRollCallIds([stored(1)], [incoming(10, { chamber: 'H' })])].sort()).toEqual([1])
  })
})

describe('deleteOtherRollCalls', () => {
  beforeEach(clearDb)

  it('deletes the bill\'s other roll calls and their member votes, and nothing of another bill', async () => {
    const row = (id: number, bill: number) => env.DB.prepare(
      `INSERT INTO roll_calls (roll_call_id, bill_id, date, yea, nay, nv, absent, total, passed) VALUES (?, ?, '2026-03-03', 1, 0, 0, 0, 1, 1)`).bind(id, bill)
    const member = (rc: number) => env.DB.prepare(
      `INSERT INTO roll_call_votes (id, roll_call_id, people_id, vote_id, vote_text) VALUES (?, ?, 1, 1, 'Yea')`).bind(`${rc}-1`, rc)
    const bill = (id: number, provider: string) => env.DB.prepare(
      `INSERT INTO bills (bill_id, change_hash, session_id, state, provider, state_id, bill_number, title, status) VALUES (?, 'h', 1, 'VA', ?, 46, 'HB1', 't', 1)`).bind(id, provider)
    await env.DB.batch([bill(100, 'lis'), bill(200, 'lis'), row(1, 100), row(2, 100), row(3, 100), row(4, 200), member(1), member(2), member(4)])

    await deleteOtherRollCalls(env.DB, 100, 'lis', [1, 3])
    const ids = async () => (await env.DB.prepare('SELECT roll_call_id AS id FROM roll_calls ORDER BY 1').all<{ id: number }>()).results.map(r => r.id)
    const votes = async () => (await env.DB.prepare('SELECT roll_call_id AS id FROM roll_call_votes ORDER BY 1').all<{ id: number }>()).results.map(r => r.id)
    expect(await ids()).toEqual([1, 3, 4])
    expect(await votes()).toEqual([1, 4])

    // No roll calls named: the bill has none, and the other bill is untouched.
    await deleteOtherRollCalls(env.DB, 100, 'lis', [])
    expect(await ids()).toEqual([4])
    expect(await votes()).toEqual([4])
  })

  it('leaves a bill another provider has taken since the ingest began', async () => {
    const bill = env.DB.prepare(
      `INSERT INTO bills (bill_id, change_hash, session_id, state, provider, state_id, bill_number, title, status) VALUES (100, 'h', 1, 'VA', 'legiscan', 46, 'HB1', 't', 1)`)
    const rc = env.DB.prepare(
      `INSERT INTO roll_calls (roll_call_id, bill_id, date, yea, nay, nv, absent, total, passed) VALUES (1, 100, '2026-03-03', 1, 0, 0, 0, 1, 1)`)
    await env.DB.batch([bill, rc])
    // The ingest is the LIS's, and the bill is LegiScan's now.
    await deleteOtherRollCalls(env.DB, 100, 'lis', [])
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM roll_calls').first<{ n: number }>())!.n).toBe(1)
  })
})
