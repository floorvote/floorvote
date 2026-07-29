import { execSync } from 'child_process'
import { writeFileSync, unlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { esc, num, buildBillStatements } from './build-bill-statements'

export { esc, num }

// REPO_ROOT must be passed in so this module works regardless of cwd
export interface SeedCentralDbOptions {
  repoRoot: string
  dbName: string
  wranglerEnv: string
  locationFlag: '--remote' | '--local'
  /** Skip both roll_calls and roll_call_votes entirely. */
  skipVotes?: boolean
  /**
   * Include the per-legislator rows (`roll_call_votes`). Defaults to false
   * because nothing in the codebase reads them — central exposes only
   * `roll_calls` aggregates, the tenant never sees individuals, the UI shows
   * aggregates only on the bill timeline, and the live ingestor doesn't write
   * them. Skipping cuts ~100k+ orphan rows on US-scale seeds. If we ever build
   * partisan-vote analysis or "how did my legislator vote", flip this on (or
   * use `--individual-votes-only` in seed-legiscan.ts to backfill against an
   * already-seeded session without redoing aggregates).
   */
  includeIndividualVotes?: boolean
}

let _tmpFiles: string[] = []

/**
 * Classify a wrangler/D1 error message as a transient (retryable) blip.
 *
 * The original filter only matched `timed out`/`timeout`/`503`. That was too
 * narrow: a `fetch failed` / `Network connection lost` / `429` / other 5xx blip
 * fell through to the non-transient branch, threw, and — because the bills loop
 * wrapped `flush()` in its per-bill try/catch — was silently swallowed, dropping
 * a whole buffered batch. (That is exactly how 58 TX bills went missing from a
 * "successful" seed.) Be liberal here: a false positive just costs a couple of
 * retries before the error is (now loudly) re-thrown, whereas a false negative
 * loses data.
 */
export function isTransientD1Error(msg: string): boolean {
  return /timed out|timeout|\b(408|409|425|429|500|502|503|504)\b|fetch failed|network connection lost|econnreset|epipe|socket hang up|too many requests|internal error|service unavailable|could not reach|connection (refused|reset|closed)/i.test(msg)
}

export function runSql(
  statements: string[],
  opts: SeedCentralDbOptions,
  retries = 3,
): void {
  if (statements.length === 0) return
  const tmpFile = join(tmpdir(), `ls-seed-${Date.now()}-${Math.random().toString(36).slice(2)}.sql`)
  _tmpFiles.push(tmpFile)
  writeFileSync(tmpFile, statements.join('\n'), 'utf-8')
  const cmd = `npx wrangler d1 execute ${opts.dbName} --env ${opts.wranglerEnv} ${opts.locationFlag} --file ${tmpFile}`
  let lastErr: unknown
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      execSync(cmd, { stdio: 'pipe', cwd: join(opts.repoRoot, 'central') })
      lastErr = undefined
      break
    } catch (err: unknown) {
      lastErr = err
      const msg = ((err as any).stderr?.toString() ?? '') + ((err as any).stdout?.toString() ?? '')
      const transient = isTransientD1Error(msg)
      if (transient && attempt < retries) {
        const delaySec = attempt * attempt * 10  // 10s, 40s, 90s — give CF time to recover
        console.error(`  [retry ${attempt}/${retries} — waiting ${delaySec}s] ${msg.split('\n')[0]}`)
        execSync(`sleep ${delaySec}`)
      } else {
        console.error(`  [wrangler error] ${msg}`)
        break
      }
    }
  }
  try { unlinkSync(tmpFile) } catch {}
  _tmpFiles = _tmpFiles.filter(f => f !== tmpFile)
  if (lastErr) throw lastErr
}

export function runInChunks(
  statements: string[],
  opts: SeedCentralDbOptions,
  chunkSize = 50,
): void {
  for (let i = 0; i < statements.length; i += chunkSize) {
    runSql(statements.slice(i, i + chunkSize), opts)
  }
}

/** Clean up any leftover temp SQL files (call in process exit handlers). */
export function cleanupTmpFiles(): void {
  for (const f of _tmpFiles) { try { unlinkSync(f) } catch {} }
}

export interface SeedResult {
  billCount: number
  errorCount: number
}

/**
 * Seed the central LegiScan D1 from an in-memory file map.
 *
 * `files` keys must follow ZIP layout: `{STATE}/{SESSION_DIR}/bill/X.json`,
 * `…/people/X.json`, `…/vote/X.json`. Both disk-built maps and fflate unzip
 * output satisfy this when constructed with the state/session dir prefix.
 */
export function seedCentralDb(
  files: Record<string, Uint8Array>,
  state: string,
  sessionId: number,
  opts: SeedCentralDbOptions,
): SeedResult {
  const decoder = new TextDecoder()
  _tmpFiles = []

  const billFiles = Object.keys(files).filter(n => /\/bill\/[^/]+\.json$/.test(n))
  const voteFiles = Object.keys(files).filter(n => /\/vote\/[^/]+\.json$/.test(n))
  const peopleFiles = Object.keys(files).filter(n => /\/people\/[^/]+\.json$/.test(n))

  if (billFiles.length === 0) throw new Error('No bill files found in file map')

  // ── Session row ──────────────────────────────────────────────────────────
  const firstBill = JSON.parse(decoder.decode(files[billFiles[0]])).bill
  const session = firstBill?.session
  if (!session) throw new Error('Cannot read session metadata from first bill file')

  console.log(`  Session title: "${session.session_title}"`)
  console.log(`  Bills: ${billFiles.length}  People: ${peopleFiles.length}  Votes: ${voteFiles.length}`)

  runSql([
    `INSERT OR REPLACE INTO sessions (session_id, state, state_id, year_start, year_end, prefile, sine_die, prior, special, session_tag, session_title, session_name)
VALUES (${num(sessionId)}, ${esc(state)}, ${num(session.state_id)}, ${num(session.year_start)}, ${num(session.year_end)}, ${num(session.prefile ?? 0)}, ${num(session.sine_die ?? 0)}, ${num(session.prior ?? 0)}, ${num(session.special ?? 0)}, ${esc(session.session_tag ?? '')}, ${esc(session.session_title ?? '')}, ${esc(session.session_name ?? '')});`,
  ], opts)
  console.log('  ✓ Session row upserted')

  // ── People ────────────────────────────────────────────────────────────────
  if (peopleFiles.length > 0) {
    const stmts: string[] = []
    for (const name of peopleFiles) {
      try {
        const p = JSON.parse(decoder.decode(files[name])).person
        if (!p) continue
        const bioJson = p.bio ? esc(JSON.stringify(p.bio)) : 'NULL'
        stmts.push(
          `INSERT OR REPLACE INTO people (people_id, person_hash, state_id, party_id, party, role_id, role, name, first_name, middle_name, last_name, suffix, nickname, district, ftm_eid, votesmart_id, opensecrets_id, knowwho_pid, ballotpedia, bioguide_id, bio_json)
VALUES (${num(p.people_id)}, ${esc(p.person_hash)}, ${num(p.state_id)}, ${esc(p.party_id)}, ${esc(p.party)}, ${num(p.role_id)}, ${esc(p.role)}, ${esc(p.name)}, ${esc(p.first_name)}, ${esc(p.middle_name)}, ${esc(p.last_name)}, ${esc(p.suffix)}, ${esc(p.nickname)}, ${esc(p.district)}, ${num(p.ftm_eid)}, ${num(p.votesmart_id)}, ${esc(p.opensecrets_id)}, ${num(p.knowwho_pid)}, ${esc(p.ballotpedia)}, ${esc(p.bioguide_id)}, ${bioJson});`,
        )
      } catch { /* skip malformed */ }
    }
    runInChunks(stmts, opts)
    console.log(`  ✓ ${peopleFiles.length} people seeded`)
  }

  // ── Bills + all child tables ──────────────────────────────────────────────
  const FLUSH_EVERY = 30
  let billCount = 0
  let errorCount = 0
  let pending: string[] = []
  // Clear `pending` only AFTER the SQL succeeds. runInChunks throws on a
  // non-transient wrangler/D1 failure; keeping the buffer on throw means the
  // batch is never silently lost, and the throw propagates to abort the seed.
  const flush = () => {
    if (pending.length === 0) return
    runInChunks(pending, opts, 50)
    pending = []
  }

  for (const name of billFiles) {
    // The try guards ONLY per-bill parse / statement-building: a single malformed
    // bill is skipped and counted, then we move on. flush() is deliberately OUTSIDE
    // it — a wrangler/D1 failure must never be mistaken for a one-bill error and
    // swallowed (that silently dropped whole batches; see the 58-bill TX gap). Let
    // it throw and abort; seeding is idempotent (INSERT OR REPLACE), so a re-run
    // recovers cleanly.
    try {
      const b = JSON.parse(decoder.decode(files[name])).bill
      if (!b) continue
      pending.push(...buildBillStatements(b, state, sessionId))
      billCount++
    } catch (err) {
      errorCount++
      console.error(`\n  Error building statements for ${name}: ${err}`)
      continue
    }
    if (billCount % FLUSH_EVERY === 0) {
      flush()
      process.stdout.write(`\r  Bills: ${billCount}/${billFiles.length}`)
    }
  }
  flush()
  console.log(`\r  ✓ ${billCount} bills seeded${errorCount > 0 ? ` (${errorCount} errors)` : ''}`)

  // ── Votes ─────────────────────────────────────────────────────────────────
  if (opts.skipVotes) {
    if (voteFiles.length > 0) console.log(`  Skipping ${voteFiles.length} vote files (skipVotes=true)`)
    return { billCount, errorCount }
  }
  if (voteFiles.length === 0) {
    console.log('  No vote files found, skipping')
    return { billCount, errorCount }
  }

  const VOTE_FLUSH_EVERY = 200
  let voteCount = 0
  let votePending: string[] = []
  const flushVotes = () => {
    if (votePending.length === 0) return
    runInChunks(votePending, opts, 50)
    votePending = []
  }

  const includeIndividual = opts.includeIndividualVotes ?? false
  if (!includeIndividual) {
    console.log(`  Note: skipping per-legislator roll_call_votes rows (nothing reads them).`)
    console.log(`        Backfill later with: --individual-votes-only --from-dir <same path>`)
  }

  for (const name of voteFiles) {
    try {
      const rc = JSON.parse(decoder.decode(files[name])).roll_call
      if (!rc) continue
      votePending.push(`INSERT OR REPLACE INTO roll_calls (roll_call_id, bill_id, date, description, yea, nay, nv, absent, total, passed, chamber, chamber_id, url, state_link)
VALUES (${num(rc.roll_call_id)}, ${num(rc.bill_id)}, ${esc(rc.date)}, ${esc(rc.desc)}, ${num(rc.yea ?? 0)}, ${num(rc.nay ?? 0)}, ${num(rc.nv ?? 0)}, ${num(rc.absent ?? 0)}, ${num(rc.total ?? 0)}, ${num(rc.passed ?? 0)}, ${esc(rc.chamber)}, ${num(rc.chamber_id)}, ${esc(rc.url)}, ${esc(rc.state_link)});`)
      if (includeIndividual) {
        for (const v of (rc.votes ?? [])) {
          votePending.push(`INSERT OR IGNORE INTO roll_call_votes (id, roll_call_id, people_id, vote_id, vote_text)
VALUES (${esc(`${rc.roll_call_id}-${v.people_id}`)}, ${num(rc.roll_call_id)}, ${num(v.people_id)}, ${num(v.vote_id)}, ${esc(v.vote_text)});`)
        }
      }
      voteCount++
    } catch { continue /* skip malformed vote file */ }
    // flush OUTSIDE the try — a D1 failure here must abort, not be swallowed as "malformed".
    if (voteCount % VOTE_FLUSH_EVERY === 0) {
      flushVotes()
      process.stdout.write(`\r  Votes: ${voteCount}/${voteFiles.length}`)
    }
  }
  flushVotes()
  console.log(`\r  ✓ ${voteCount} vote files seeded (roll_calls${includeIndividual ? ' + roll_call_votes' : ' only'})`)

  return { billCount, errorCount }
}

/**
 * Backfill `roll_call_votes` rows for an already-seeded session.
 *
 * Reads only the vote/*.json files from the file map and writes only the
 * per-legislator rows. Does not touch `roll_calls` (assumes those already
 * exist), bills, people, etc. Safe to re-run; uses INSERT OR IGNORE.
 *
 * Use when you decide later that you do want individual votes and want to
 * avoid re-seeding everything else.
 */
export function seedIndividualVotesOnly(
  files: Record<string, Uint8Array>,
  opts: SeedCentralDbOptions,
): { voteCount: number; rowCount: number } {
  const decoder = new TextDecoder()
  _tmpFiles = []
  const voteFiles = Object.keys(files).filter(n => /\/vote\/[^/]+\.json$/.test(n))
  if (voteFiles.length === 0) {
    console.log('  No vote files found in file map')
    return { voteCount: 0, rowCount: 0 }
  }

  console.log(`  Backfilling roll_call_votes from ${voteFiles.length} vote files...`)
  const FLUSH_EVERY = 200
  let voteCount = 0
  let rowCount = 0
  let pending: string[] = []
  const flush = () => { if (pending.length > 0) { runInChunks(pending, opts, 500); pending = [] } }

  for (const name of voteFiles) {
    try {
      const rc = JSON.parse(decoder.decode(files[name])).roll_call
      if (!rc) continue
      for (const v of (rc.votes ?? [])) {
        pending.push(`INSERT OR IGNORE INTO roll_call_votes (id, roll_call_id, people_id, vote_id, vote_text)
VALUES (${esc(`${rc.roll_call_id}-${v.people_id}`)}, ${num(rc.roll_call_id)}, ${num(v.people_id)}, ${num(v.vote_id)}, ${esc(v.vote_text)});`)
        rowCount++
      }
      voteCount++
    } catch { continue /* skip malformed vote file */ }
    if (voteCount % FLUSH_EVERY === 0) {
      flush()
      process.stdout.write(`\r  Votes: ${voteCount}/${voteFiles.length} (${rowCount} individual rows)`)
    }
  }
  flush()
  console.log(`\r  ✓ ${voteCount} vote files → ${rowCount} roll_call_votes rows`)
  return { voteCount, rowCount }
}
