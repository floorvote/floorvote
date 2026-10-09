// Main seam for the weekly per-member vote load: a recorded-shape LegiScan
// bulk dataset (a small ZIP built here) with the network stubbed, run through
// the daily check and the queued load into a migrated central D1, then read
// back only through central's bill API, the call log the budget counts, and
// the tenant queues.
import { env } from 'cloudflare:test'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { drizzle } from 'drizzle-orm/d1'
import { sql } from 'drizzle-orm'
import { zipSync, strToU8 } from 'fflate'
import * as schema from '../../src/db/schema'
import { setupLsDb } from '../helpers/setupLsDb'

const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)

import { app } from '../../src/index-legiscan'
import { checkVoteDatasets, loadVoteDataset, datasetUnzip, VOTE_DATASET_DEFER_SECONDS, VOTE_DATASET_RETRY_SECONDS } from '../../src/cron/vote-datasets'
import { processIngestorQueue } from '../../src/queue/processor'
import type { IngestorMessage } from '../../src/types'

const db = drizzle(env.DB, { schema })
const DIR = 'RI/2026-2026_Regular_Session'

type Vote = [peopleId: number, voteText: string]
const voteFile = (rollCallId: number, billId: number, votes: Vote[]) => ({
  roll_call: {
    roll_call_id: rollCallId, bill_id: billId, date: '2026-03-01', desc: 'Third Reading',
    yea: votes.filter(v => v[1] === 'Yea').length, nay: votes.filter(v => v[1] === 'Nay').length,
    nv: 0, absent: 0, total: votes.length, passed: 1, chamber: 'H', chamber_id: 77,
    votes: votes.map(([people_id, vote_text]) => ({ people_id, vote_id: vote_text === 'Yea' ? 1 : 2, vote_text })),
  },
})
const personFile = (people_id: number, name: string, person_hash = `ph-${people_id}`) => ({
  person: { people_id, person_hash, state_id: 39, party_id: '1', party: 'D', role_id: 1, role: 'Rep', name,
    first_name: name.split(' ')[0], last_name: name.split(' ')[1], district: `HD-00${people_id}` },
})

/** A dataset ZIP laid out like LegiScan's: STATE/SESSION/{bill,vote,people}/*.json. */
function datasetZip(files: { votes: ReturnType<typeof voteFile>[]; people: ReturnType<typeof personFile>[] }): Uint8Array {
  const entries: Record<string, Uint8Array> = {
    [`${DIR}/bill/H102.json`]: strToU8(JSON.stringify({ bill: { bill_id: 102, bill_number: 'H102' } })),
  }
  for (const v of files.votes) entries[`${DIR}/vote/${v.roll_call.roll_call_id}.json`] = strToU8(JSON.stringify(v))
  for (const p of files.people) entries[`${DIR}/people/${p.person.people_id}.json`] = strToU8(JSON.stringify(p))
  return zipSync(entries)
}

/** Serve bytes in small chunks, so ZIP entries straddle reads the way a real download does. */
function chunked(bytes: Uint8Array, size = 97): ReadableStream<Uint8Array> {
  let offset = 0
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) return controller.close()
      controller.enqueue(bytes.slice(offset, offset + size))
      offset += size
    },
  })
}

const FIRST = datasetZip({
  votes: [voteFile(31, 102, [[1, 'Yea'], [2, 'Nay'], [3, 'Yea']])],
  people: [personFile(1, 'Ann Able'), personFile(2, 'Bo Baker'), personFile(3, 'Cy Carter')],
})

let datasetList: unknown[]
let zipBody: () => Response
function stubLegiscan() {
  fetchMock.mockImplementation(async (url: string) => {
    const op = new URL(url).searchParams.get('op')
    if (op === 'getDatasetList') return new Response(JSON.stringify({ status: 'OK', datasetlist: datasetList }))
    if (op === 'getDatasetRaw') return zipBody()
    throw new Error(`unexpected LegiScan op ${op}`)
  })
}

const ingestorSend = vi.fn()
const tenantSend = vi.fn()
const mockEnv = () => ({
  ...(env as any),
  INGESTOR_QUEUE: { send: ingestorSend, sendBatch: vi.fn() },
  TENANT_QUEUE_ACME: { send: tenantSend, sendBatch: tenantSend },
})

/** Deliver what the check queued, as the ingestor consumer would. */
async function deliverQueued() {
  const bodies = ingestorSend.mock.calls.map(c => c[0] as IngestorMessage)
  ingestorSend.mockClear()
  const messages = bodies.map(body => ({ body, ack: vi.fn(), retry: vi.fn() }))
  await processIngestorQueue({ messages } as unknown as MessageBatch<IngestorMessage>, mockEnv(), db)
  return messages
}

async function legislatorVotes(billId: number, rollCallId: number) {
  const res = await app.request(`/api/bills/legiscan:${billId}`, { headers: { 'x-admin-secret': 'test-secret' } }, env)
  const body = await res.json() as { votes: { id: string; legislatorVotes: unknown[] }[] }
  return body.votes.find(v => v.id === String(rollCallId))?.legislatorVotes
}

async function callsLogged(): Promise<Record<string, number>> {
  // trackLsCall logs without awaiting; let those writes land first.
  await new Promise(r => setTimeout(r, 20))
  const rows = await db.select({ callType: schema.apiCallLog.callType }).from(schema.apiCallLog).all()
  const counts: Record<string, number> = {}
  for (const r of rows) counts[r.callType] = (counts[r.callType] ?? 0) + 1
  return counts
}

const weekPasses = () => db.run(sql`UPDATE sessions SET votes_checked_at = datetime('now', '-7 days')`)

beforeEach(async () => {
  await setupLsDb()
  fetchMock.mockReset()
  ingestorSend.mockReset()
  tenantSend.mockReset()
  datasetList = [
    { session_id: 1, state_id: 39, dataset_hash: 'hash-1', dataset_size: 1000, access_key: 'key-1' },
    { session_id: 2, state_id: 39, dataset_hash: 'hash-old', dataset_size: 1000, access_key: 'key-2' },
  ]
  zipBody = () => new Response(chunked(FIRST), { headers: { 'content-type': 'application/zip' } })
  stubLegiscan()

  await db.insert(schema.tenants).values({ tenantId: 'acme', name: 'Acme', stateCoverage: JSON.stringify(['RI']), active: true })
  await db.insert(schema.sessions).values([
    { sessionId: 1, state: 'RI', stateId: 39, yearStart: 2026, yearEnd: 2026, sessionName: '2026 Regular', sessionTitle: 'Regular' },
    // Adjourned: the hourly sync no longer covers it, so neither does the vote load.
    { sessionId: 2, state: 'RI', stateId: 39, yearStart: 2025, yearEnd: 2025, sessionName: '2025 Regular', sessionTitle: 'Regular', sineDie: 1 },
    // No instance covers MA.
    { sessionId: 3, state: 'MA', stateId: 22, yearStart: 2026, yearEnd: 2026, sessionName: 'MA 2026', sessionTitle: 'Regular' },
  ])
  await db.insert(schema.bills).values({ billId: 102, sessionId: 1, state: 'RI', stateId: 39, billNumber: 'H102', title: 'Bill 102', changeHash: 'h', status: 1 })
  await db.insert(schema.billTenants).values({ billId: 102, tenantId: 'acme', matchType: 'keyword' })
  // The roll call's totals, as the bill ingest writes them from getBill.
  await db.insert(schema.rollCalls).values({ rollCallId: 31, billId: 102, date: '2026-03-01', description: 'Third Reading', yea: 2, nay: 1, total: 3, passed: 1, chamber: 'H' })
  // Ann sponsored a bill, so the ingest already wrote her people row.
  await db.insert(schema.people).values({ peopleId: 1, personHash: 'ph-1', name: 'Ann Able', stateId: 39 })
})

describe('weekly LegiScan member votes', () => {
  it('backfills a covered session on the first run and shows each legislator on the bill', async () => {
    // Three-byte reads: the ZIP check must not assume a read holds its first four bytes.
    zipBody = () => new Response(chunked(FIRST, 3), { headers: { 'content-type': 'application/zip' } })
    expect(await legislatorVotes(102, 31)).toEqual([])

    await checkVoteDatasets(mockEnv(), db)
    expect(ingestorSend).toHaveBeenCalledTimes(1)
    expect(ingestorSend).toHaveBeenCalledWith({ kind: 'vote-dataset', providerId: 'legiscan', sessionId: 1, key: 'key-1', hash: 'hash-1' })

    const [msg] = await deliverQueued()
    expect(msg.ack).toHaveBeenCalled()
    expect(msg.retry).not.toHaveBeenCalled()

    // Cy never sponsored anything; the dataset's people/ file gives the name.
    expect(await legislatorVotes(102, 31)).toEqual([
      { personId: '1', name: 'Ann Able', vote: 'Yea' },
      { personId: '2', name: 'Bo Baker', vote: 'Nay' },
      { personId: '3', name: 'Cy Carter', vote: 'Yea' },
    ])
    // About two calls for the session, both counted toward the budget.
    expect(await callsLogged()).toEqual({ getDatasetList: 1, getDatasetRaw: 1 })
    // Instances read member votes when a bill page opens; nobody is notified.
    expect(tenantSend).not.toHaveBeenCalled()
  })

  it("doesn't overwrite a legislator the ingest already wrote with the dataset's older details", async () => {
    await db.run(sql`UPDATE people SET name = 'Ann Able-Smith', person_hash = 'ph-1-newer' WHERE people_id = 1`)
    await checkVoteDatasets(mockEnv(), db)
    await deliverQueued()
    expect((await legislatorVotes(102, 31))?.[0]).toEqual({ personId: '1', name: 'Ann Able-Smith', vote: 'Yea' })
  })

  it('checks only sessions instances cover: one list call for RI, none for MA', async () => {
    await checkVoteDatasets(mockEnv(), db)
    const ops = fetchMock.mock.calls.map(c => new URL(c[0] as string))
    expect(ops.map(u => [u.searchParams.get('op'), u.searchParams.get('state')])).toEqual([['getDatasetList', 'RI']])
    // Session 2 is in the list with a hash never loaded, but it adjourned.
    expect(ingestorSend.mock.calls.map(c => c[0].sessionId)).toEqual([1])
  })

  it('costs one getDatasetList call a week while the dataset is unchanged', async () => {
    await checkVoteDatasets(mockEnv(), db)
    await deliverQueued()
    fetchMock.mockClear()

    // The next day's tick: nothing is due yet.
    await checkVoteDatasets(mockEnv(), db)
    expect(fetchMock).not.toHaveBeenCalled()

    await weekPasses()
    await checkVoteDatasets(mockEnv(), db)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(ingestorSend).not.toHaveBeenCalled()
    expect(await callsLogged()).toEqual({ getDatasetList: 2, getDatasetRaw: 1 })
  })

  it("writes votes only for roll calls central has, and rewrites one whose vote count changed", async () => {
    await checkVoteDatasets(mockEnv(), db)
    await deliverQueued()

    // A week later: the ingest has written roll call 32. Roll call 33 belongs
    // to a bill central hasn't fetched. Roll call 31 differs in the file but
    // has the same count, and recorded roll calls are static, so it stays.
    await db.insert(schema.rollCalls).values({ rollCallId: 32, billId: 102, date: '2026-03-08', description: 'Concurrence', yea: 1, nay: 1, total: 2, passed: 0, chamber: 'H' })
    const people = [personFile(1, 'Ann Able'), personFile(2, 'Bo Baker'), personFile(3, 'Cy Carter'), personFile(4, 'Di Dunn')]
    const second = datasetZip({
      votes: [voteFile(31, 102, [[1, 'Nay'], [2, 'Nay'], [3, 'Nay']]), voteFile(32, 102, [[2, 'Yea'], [4, 'Nay']]), voteFile(33, 103, [[1, 'Yea']])],
      people,
    })
    datasetList = [{ session_id: 1, dataset_hash: 'hash-2', access_key: 'key-1b' }]
    zipBody = () => new Response(chunked(second), { headers: { 'content-type': 'application/zip' } })
    await weekPasses()
    await checkVoteDatasets(mockEnv(), db)
    expect(ingestorSend).toHaveBeenCalledWith({ kind: 'vote-dataset', providerId: 'legiscan', sessionId: 1, key: 'key-1b', hash: 'hash-2' })
    await deliverQueued()

    expect(await legislatorVotes(102, 32)).toEqual([
      { personId: '2', name: 'Bo Baker', vote: 'Yea' },
      { personId: '4', name: 'Di Dunn', vote: 'Nay' },
    ])
    expect((await legislatorVotes(102, 31))?.map(v => (v as { vote: string }).vote)).toEqual(['Yea', 'Nay', 'Yea'])

    // The next week the ingest has fetched bill 103, and LegiScan corrected
    // roll call 31 with a vote it had missed.
    await db.insert(schema.bills).values({ billId: 103, sessionId: 1, state: 'RI', stateId: 39, billNumber: 'H103', title: 'Bill 103', changeHash: 'h', status: 1 })
    await db.insert(schema.rollCalls).values({ rollCallId: 33, billId: 103, date: '2026-03-09', description: 'Passage', yea: 1, total: 1, passed: 1, chamber: 'H' })
    const third = datasetZip({
      votes: [voteFile(31, 102, [[1, 'Yea'], [2, 'Nay'], [3, 'Yea'], [4, 'Yea']]), voteFile(32, 102, [[2, 'Yea'], [4, 'Nay']]), voteFile(33, 103, [[1, 'Yea']])],
      people,
    })
    datasetList = [{ session_id: 1, dataset_hash: 'hash-3', access_key: 'key-1c' }]
    zipBody = () => new Response(chunked(third), { headers: { 'content-type': 'application/zip' } })
    await weekPasses()
    await checkVoteDatasets(mockEnv(), db)
    await deliverQueued()

    expect(await legislatorVotes(103, 33)).toEqual([{ personId: '1', name: 'Ann Able', vote: 'Yea' }])
    expect(await legislatorVotes(102, 31)).toHaveLength(4)
  })

  it('runs one dataset load per invocation and defers the rest of the batch', async () => {
    await db.run(sql`UPDATE sessions SET sine_die = 0 WHERE session_id = 2`)
    await checkVoteDatasets(mockEnv(), db)
    expect(ingestorSend.mock.calls.map(c => c[0].sessionId)).toEqual([1, 2])

    const [first, second] = await deliverQueued()
    expect(first.ack).toHaveBeenCalled()
    expect(second.ack).toHaveBeenCalled()
    expect(second.retry).not.toHaveBeenCalled()
    // Re-sent with a delay instead of loaded here, and only one download so far.
    expect(ingestorSend).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 2 }), { delaySeconds: VOTE_DATASET_DEFER_SECONDS })
    expect(await callsLogged()).toEqual({ getDatasetList: 1, getDatasetRaw: 1 })
  })

  it('hands the rest of a large load to a fresh message when one invocation would run out of queries', async () => {
    await db.insert(schema.rollCalls).values({ rollCallId: 32, billId: 102, date: '2026-03-08', description: 'Concurrence', yea: 1, nay: 1, total: 2, passed: 0, chamber: 'H' })
    const big = datasetZip({
      votes: [voteFile(31, 102, [[1, 'Yea'], [2, 'Nay'], [3, 'Yea']]), voteFile(32, 102, [[2, 'Yea'], [3, 'Nay']])],
      people: [personFile(1, 'Ann Able'), personFile(2, 'Bo Baker'), personFile(3, 'Cy Carter')],
    })
    zipBody = () => new Response(chunked(big), { headers: { 'content-type': 'application/zip' } })
    await checkVoteDatasets(mockEnv(), db)
    const msg = ingestorSend.mock.calls[0][0]
    ingestorSend.mockClear()

    // A budget of one statement: each pass stops after its first write.
    await loadVoteDataset(msg, mockEnv(), db, { flushRollCalls: 1, statementBudget: 1 })
    expect(ingestorSend).toHaveBeenCalledWith(msg)
    expect(await legislatorVotes(102, 31)).toHaveLength(3)
    expect(await legislatorVotes(102, 32)).toEqual([])

    // Continuations finish, skipping what is already written, and record the hash.
    while (ingestorSend.mock.calls.length > 0) await deliverQueued()
    expect(await legislatorVotes(102, 32)).toHaveLength(2)
    await weekPasses()
    await checkVoteDatasets(mockEnv(), db)
    expect(ingestorSend).not.toHaveBeenCalled()
  })

  it('fails closed when the download is not a ZIP: retried later, and the hash is not recorded', async () => {
    zipBody = () => new Response('<html>Service temporarily unavailable</html>', { headers: { 'content-type': 'text/html' } })
    await checkVoteDatasets(mockEnv(), db)
    const [msg] = await deliverQueued()
    expect(msg.retry).toHaveBeenCalledWith({ delaySeconds: VOTE_DATASET_RETRY_SECONDS })
    expect(msg.ack).not.toHaveBeenCalled()
    expect(await legislatorVotes(102, 31)).toEqual([])

    // Next week's check queues the same dataset again.
    await weekPasses()
    await checkVoteDatasets(mockEnv(), db)
    expect(ingestorSend).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 1, hash: 'hash-1' }))
  })

  it('fails closed on a LegiScan error body', async () => {
    zipBody = () => new Response(JSON.stringify({ status: 'ERROR', alert: { message: 'Invalid access key' } }), { headers: { 'content-type': 'application/json' } })
    await checkVoteDatasets(mockEnv(), db)
    const [msg] = await deliverQueued()
    expect(msg.retry).toHaveBeenCalledWith({ delaySeconds: VOTE_DATASET_RETRY_SECONDS })
    expect(await legislatorVotes(102, 31)).toEqual([])
  })

  it('fails closed on an archive with an unexpected layout', async () => {
    const odd = zipSync({ 'README.txt': strToU8('hello'), [`${DIR}/votes.json`]: strToU8('[]') })
    zipBody = () => new Response(chunked(odd), { headers: { 'content-type': 'application/zip' } })
    await checkVoteDatasets(mockEnv(), db)
    const [msg] = await deliverQueued()
    expect(msg.retry).toHaveBeenCalled()
    await weekPasses()
    await checkVoteDatasets(mockEnv(), db)
    expect(ingestorSend).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 1, hash: 'hash-1' }))
  })

  it('keeps the old hash when a vote file is malformed, after writing the ones that parse', async () => {
    const bad = zipSync({
      [`${DIR}/vote/31.json`]: strToU8(JSON.stringify(voteFile(31, 102, [[1, 'Yea'], [2, 'Nay'], [3, 'Yea']]))),
      [`${DIR}/vote/33.json`]: strToU8('{"roll_call": {"roll_call_id": "not a number"}}'),
    })
    zipBody = () => new Response(chunked(bad), { headers: { 'content-type': 'application/zip' } })
    await checkVoteDatasets(mockEnv(), db)
    const [msg] = await deliverQueued()
    expect(msg.ack).toHaveBeenCalled()
    expect(await legislatorVotes(102, 31)).toHaveLength(3)

    await weekPasses()
    await checkVoteDatasets(mockEnv(), db)
    expect(ingestorSend).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 1, hash: 'hash-1' }))
  })
})

describe('dataset unzip', () => {
  it("doesn't hold on to the bytes of entries it skips", () => {
    // Incompressible bill/ entries first, as in a real dataset, then a vote.
    const entries: Record<string, Uint8Array> = {}
    for (let i = 0; i < 40; i++) {
      entries[`${DIR}/bill/H${i}.json`] = crypto.getRandomValues(new Uint8Array(50_000))
    }
    entries[`${DIR}/vote/31.json`] = strToU8(JSON.stringify(voteFile(31, 102, [[1, 'Yea']])))
    const zip = zipSync(entries)

    const seen: string[] = []
    const unzip = datasetUnzip((kind, bytes) => {
      if (kind === 'vote') seen.push(new TextDecoder().decode(bytes))
    }, err => { throw err })
    let maxRetained = 0
    for (let o = 0; o < zip.length; o += 65_536) {
      unzip.push(zip.subarray(o, o + 65_536), o + 65_536 >= zip.length)
      // fflate's private per-entry buffer (Unzip.k): where unstarted entries'
      // bytes pile up. Reached into on purpose, since that pile-up is the bug.
      let retained = 0
      for (const chunks of (unzip as unknown as { k: Uint8Array[][] }).k) for (const c of chunks) retained += c.byteLength
      maxRetained = Math.max(maxRetained, retained)
    }
    expect(seen).toHaveLength(1)
    expect(JSON.parse(seen[0]).roll_call.roll_call_id).toBe(31)
    // The archive is about 2 MB. Without the fix this reaches nearly all of it.
    expect(zip.length).toBeGreaterThan(1_900_000)
    expect(maxRetained).toBeLessThan(200_000)
  })
})
