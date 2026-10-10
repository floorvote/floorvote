// Weekly per-member votes from a provider's vote datasets.
//
// For LegiScan, getBill carries only each roll call's totals. Each
// legislator's vote is in getRollCall, one quota call per roll call, which the
// 10,000-call monthly budget can't afford. The weekly bulk dataset for a
// session holds every getRollCall record as vote/*.json, so a whole session's
// votes cost one download. Any provider with `listVoteDatasets` and
// `fetchVoteDataset` gets the same load. See
// docs/internal/legiscan-member-votes.md.
//
// Two halves:
//   checkVoteDatasets (hourly cron, acts once a day) compares each covered
//     session's dataset hash with the one last loaded: one listVoteDatasets
//     call per state with a session due. A changed session is queued.
//   loadVoteDataset (ingestor queue) downloads that session's ZIP, inflates only
//     vote/ and people/ entries as the bytes arrive, and writes the votes of
//     roll calls central has whose stored votes are missing or incomplete.

import { and, eq, inArray, isNull, lt, ne, or, sql } from 'drizzle-orm'
import { Unzip, UnzipInflate, type UnzipDecoder } from 'fflate'
import { sessions, tenants } from '../db/schema'
import { DEFAULT_PROVIDER_ID, getProvider, type MeasurePerson } from '../providers'
import { insertMissingPeople, personRow } from '../lib/people'
import { providerContext } from '../lib/providerContext'
import { directStates } from '../lib/providerRouting'
import { storedVoteCounts, writeMemberVotes, type RollCallMemberVotes } from '../lib/rollCallVotes'
import { loadTrackedStates } from './sync'
import type { VoteDatasetMessage, Db, Env } from '../types'

/**
 * ET hour of the daily check. No sync pass runs at 3 ET by default, so the
 * check, and the loads it queues, don't compete with bill ingests for the
 * queue consumer or a consumer invocation's query budget.
 */
export const VOTE_DATASET_CHECK_HOUR_ET = 3

/**
 * A session is due when its hash was last compared more than six days ago.
 * Checked daily at the same hour, that is once a week, and a check that failed
 * is simply retried the next day.
 */
const CHECK_INTERVAL = '-6 days'

/** Roll calls to write, held before one write. */
const FLUSH_ROLL_CALLS = 300

/**
 * D1 statements one load may spend before it hands the rest to a fresh queue
 * message. A consumer invocation gets about 1,000 and runs at most one dataset
 * load (queue/processor defers the others), and its batch can also carry
 * bill messages. A continuation re-downloads the archive, one more call, but
 * since only roll calls central already has are written, a load rarely needs
 * one.
 */
const STATEMENT_BUDGET = 400

/** Delay before a deferred dataset load runs, and before a failed one retries. */
export const VOTE_DATASET_DEFER_SECONDS = 300
export const VOTE_DATASET_RETRY_SECONDS = 900

type EntryKind = 'bill' | 'vote' | 'person'
function entryKind(name: string): EntryKind | null {
  if (/(^|\/)vote\/[^/]+\.json$/.test(name)) return 'vote'
  if (/(^|\/)people\/[^/]+\.json$/.test(name)) return 'person'
  if (/(^|\/)bill\/[^/]+\.json$/.test(name)) return 'bill'
  return null
}

/**
 * Queue a dataset load for each covered session whose dataset changed since
 * its votes were last loaded. "Covered" is what the hourly sync covers: a
 * session of a state an active instance tracks, with sync enabled and not
 * adjourned sine die. Older sessions are backfilled with the bulk seeder.
 * States another provider owns, and its sessions, are left out like the sync
 * leaves them out.
 */
export async function checkVoteDatasets(env: Env, db: Db): Promise<void> {
  // States don't record their provider yet, so every state uses the default.
  const provider = getProvider(DEFAULT_PROVIDER_ID)
  if (!provider.listVoteDatasets || !provider.fetchVoteDataset) return
  const ctx = providerContext(provider, env, db)

  const activeTenants = await db.select({ stateCoverage: tenants.stateCoverage })
    .from(tenants).where(eq(tenants.active, true)).all()
  if (activeTenants.length === 0) return
  const trackedStates = await loadTrackedStates(db, activeTenants)
  for (const state of directStates(env)) trackedStates.delete(state)
  if (trackedStates.size === 0) return

  const due = await db.select({
    sessionId: sessions.sessionId,
    state: sessions.state,
    votesDatasetHash: sessions.votesDatasetHash,
  })
    .from(sessions)
    .where(and(
      inArray(sessions.state, [...trackedStates]),
      eq(sessions.source, provider.id),
      eq(sessions.syncEnabled, true),
      ne(sessions.sineDie, 1),
      or(isNull(sessions.votesCheckedAt), lt(sessions.votesCheckedAt, sql`datetime('now', ${CHECK_INTERVAL})`)),
    ))
    .all()

  const byState = new Map<string, typeof due>()
  for (const s of due) byState.set(s.state, [...(byState.get(s.state) ?? []), s])

  for (const [state, stateSessions] of byState) {
    try {
      const datasets = await provider.listVoteDatasets(state, ctx)
      for (const s of stateSessions) {
        const dataset = datasets.find(d => d.sessionId === s.sessionId)
        if (dataset && dataset.hash !== s.votesDatasetHash) {
          const msg: VoteDatasetMessage = {
            kind: 'vote-dataset',
            providerId: provider.id,
            sessionId: s.sessionId,
            key: dataset.key,
            hash: dataset.hash,
          }
          await env.INGESTOR_QUEUE.send(msg)
          console.log(`[vote-datasets] ${state}/${s.sessionId}: dataset changed, load queued`)
        }
        // Checked either way. A queued load that fails leaves the old hash in
        // place, so the next weekly check queues it again.
        await db.update(sessions).set({ votesCheckedAt: sql`datetime('now')` })
          .where(eq(sessions.sessionId, s.sessionId))
      }
    } catch (err) {
      console.error(`[vote-datasets] dataset check failed for ${state}:`, err)
    }
  }
}

/**
 * Load one session's per-member votes from its bulk dataset, then record the
 * dataset hash as loaded.
 *
 * Only roll calls central already has are written, meaning roll calls of bills
 * the ingest has fetched (tracked bills, and seeded sessions). Votes for the
 * rest would be rows no page shows. A bill tracked later gets its votes from
 * the next changed dataset, about a week on at most.
 *
 * Roll calls are static once recorded, so one whose stored vote count matches
 * the file is skipped. One with a different count (a partial write, or a
 * LegiScan correction that adds or drops a vote) is rewritten.
 *
 * Writes go through central's shared helpers: lib/rollCallVotes for votes, and
 * lib/people (whose row mapping the bill ingest shares) for legislators the
 * ingest never saw. Nothing is sent to instances: bill pages read member votes
 * from central when they open.
 *
 * Roll call totals are left to the bill ingest. Writing them from here would
 * hide a new vote from the ingest's change detection, so tracked bills would
 * never get their "vote recorded" notification.
 */
export async function loadVoteDataset(
  msg: VoteDatasetMessage,
  env: Env,
  db: Db,
  limits = { flushRollCalls: FLUSH_ROLL_CALLS, statementBudget: STATEMENT_BUDGET },
): Promise<void> {
  const provider = getProvider(msg.providerId)
  if (!provider.fetchVoteDataset) throw new Error(`provider ${provider.id} has no vote datasets`)
  const stored = await storedVoteCounts(db, msg.sessionId)
  let statements = 1
  const stream = await provider.fetchVoteDataset(
    { sessionId: msg.sessionId, hash: msg.hash, key: msg.key }, providerContext(provider, env, db))

  const pending: RollCallMemberVotes[] = []
  const persons = new Map<number, MeasurePerson>()
  let recognized = 0
  let malformed = 0
  let unzipError: Error | null = null

  const unzip = datasetUnzip((kind, bytes) => {
    recognized++
    if (kind === 'bill') return
    try {
      const json = JSON.parse(new TextDecoder().decode(bytes)) as unknown
      if (kind === 'person') {
        const p = parsePerson(json)
        if (p) persons.set(p.people_id, p)
        else malformed++
        return
      }
      const rc = parseRollCall(json)
      if (!rc) { malformed++; return }
      const have = stored.get(rc.rollCallId)
      if (have !== undefined && rc.votes.length > 0 && have !== rc.votes.length) pending.push(rc)
    } catch {
      malformed++
    }
  }, err => { unzipError ??= err })

  let written = 0
  const flush = async () => {
    const batch = pending.splice(0)
    if (batch.length === 0) return
    // A roll call with no stored votes needs no delete first.
    statements += await writeMemberVotes(env.DB, batch.filter(rc => stored.get(rc.rollCallId) === 0), { replace: false })
    statements += await writeMemberVotes(env.DB, batch.filter(rc => stored.get(rc.rollCallId) !== 0), { replace: true })
    for (const rc of batch) stored.set(rc.rollCallId, rc.votes.length)
    written += batch.length
  }

  const reader = stream.getReader()
  // The first bytes, held until there are enough for the ZIP magic check.
  let head: Uint8Array | null = new Uint8Array(0)
  let complete = false
  for (;;) {
    const { done, value } = await reader.read()
    let chunk = value && value.length > 0 ? value : null
    if (head) {
      if (chunk) head = concat([head, chunk])
      if (head.length < 4 && !done) continue
      // Fail closed on anything that isn't a ZIP. Unzip alone would read an
      // HTML error page as an archive with no files.
      if (!(head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04)) {
        await reader.cancel()
        throw new Error(`dataset for session ${msg.sessionId} is not a ZIP archive`)
      }
      chunk = head
      head = null
    }
    if (chunk) unzip.push(chunk)
    if (done) unzip.push(new Uint8Array(0), true)
    if (unzipError) {
      await reader.cancel()
      throw unzipError
    }
    if (done || pending.length >= limits.flushRollCalls) await flush()
    if (done) { complete = true; break }
    // Over budget: stop here and let a fresh invocation finish. Only when this
    // pass wrote something, so a continuation always makes progress.
    if (statements >= limits.statementBudget && written > 0) {
      await reader.cancel()
      break
    }
  }
  // Fail closed on an archive laid out some other way: with no bill/, vote/,
  // or people/ entries, an empty result must not be recorded as loaded.
  if (complete && recognized === 0) {
    throw new Error(`dataset for session ${msg.sessionId} has no bill, vote, or people files`)
  }

  // Legislators the ingest never saw (they voted but never sponsored a bill)
  // would otherwise show without a name. Existing rows are left alone: the
  // dataset can be a week older than the getBill data that wrote them.
  statements += await insertMissingPeople(db, [...persons.values()].map(p => personRow(p, null)))

  const summary = `${written} roll calls written, ${persons.size} people read, ${malformed} malformed files, ${statements} statements`
  if (!complete) {
    await env.INGESTOR_QUEUE.send(msg)
    console.log(`[vote-datasets] session ${msg.sessionId}: statement budget reached (${summary}), continuing in a new message`)
    return
  }
  if (malformed > 0) {
    // Keep the old hash so next week's check retries. What did parse is
    // already written, and a retry of the same archive would fail the same way.
    console.error(`[vote-datasets] session ${msg.sessionId}: ${summary}; hash not recorded`)
    return
  }
  await db.update(sessions)
    .set({ votesDatasetHash: msg.hash, votesCheckedAt: sql`datetime('now')` })
    .where(eq(sessions.sessionId, msg.sessionId))
  console.log(`[vote-datasets] session ${msg.sessionId} loaded: ${summary}`)
}

/**
 * The streaming unzip for a dataset. `onEntry` gets each bill/, vote/, and
 * people/ entry as it completes, with the bytes of vote/ and people/ entries
 * (bill/ entries come with none).
 *
 * fflate's Unzip holds on to the compressed bytes of every entry that is never
 * start()ed, which for a dataset is nearly the whole archive, since bill/
 * entries are most of it. So every entry is started, and the deflate decoder
 * registered here (InflateWanted) inflates only the entries we read and drops
 * the others' bytes as they pass.
 */
export function datasetUnzip(
  onEntry: (kind: EntryKind, bytes: Uint8Array) => void,
  onError: (err: Error) => void,
): Unzip {
  const unzip = new Unzip(file => {
    const kind = entryKind(file.name)
    const wanted = kind === 'vote' || kind === 'person'
    const parts: Uint8Array[] = []
    file.ondata = (err, chunk, final) => {
      if (err) return onError(err)
      if (wanted) parts.push(chunk)
      if (final && kind) onEntry(kind, wanted ? concat(parts) : new Uint8Array(0))
    }
    file.start()
  })
  unzip.register(InflateWanted)
  return unzip
}

/** Deflate decoder that inflates vote/ and people/ entries and discards the rest unread. */
class InflateWanted implements UnzipDecoder {
  static compression = 8
  ondata: UnzipDecoder['ondata'] = () => {}
  private inner: UnzipInflate | null = null

  constructor(name: string) {
    const kind = entryKind(name)
    if (kind === 'vote' || kind === 'person') {
      this.inner = new UnzipInflate()
      this.inner.ondata = (err, data, final) => this.ondata(err, data, final)
    }
  }

  push(chunk: Uint8Array, final: boolean): void {
    if (this.inner) this.inner.push(chunk, final)
    else if (final) this.ondata(null, new Uint8Array(0), true)
  }
}

/** A vote/*.json file: `{ roll_call: { roll_call_id, votes: [{ people_id, vote_id, vote_text }] } }`. */
function parseRollCall(json: unknown): RollCallMemberVotes | null {
  const rc = (json as { roll_call?: { roll_call_id?: unknown; votes?: unknown } } | null)?.roll_call
  if (!rc || !Number.isInteger(rc.roll_call_id) || !Array.isArray(rc.votes)) return null
  const votes: RollCallMemberVotes['votes'] = []
  for (const v of rc.votes as { people_id?: unknown; vote_id?: unknown; vote_text?: unknown }[]) {
    if (!Number.isInteger(v?.people_id)) return null
    votes.push({
      peopleId: v.people_id as number,
      voteId: Number.isInteger(v.vote_id) ? v.vote_id as number : null,
      voteText: typeof v.vote_text === 'string' ? v.vote_text : null,
    })
  }
  return { rollCallId: rc.roll_call_id as number, votes }
}

/** A people/*.json file: `{ person: { people_id, name, ... } }`, getPerson's shape. */
function parsePerson(json: unknown): MeasurePerson | null {
  const p = (json as { person?: Partial<MeasurePerson> } | null)?.person
  if (!p || !Number.isInteger(p.people_id) || typeof p.name !== 'string') return null
  return p as MeasurePerson
}

function concat(parts: Uint8Array[]): Uint8Array {
  if (parts.length === 1) return parts[0]
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let offset = 0
  for (const p of parts) { out.set(p, offset); offset += p.length }
  return out
}
