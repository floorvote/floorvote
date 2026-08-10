#!/usr/bin/env tsx
/**
 * seed-legiscan.ts — Seed the central LegiScan D1 from bulk JSON data,
 * with an optional tenant link step at the end.
 *
 * Two source modes:
 *   --from-dir <path>      Read bulk JSON from a local extracted directory.
 *                          Works for any-sized dataset (US, NY, TX, CA — no
 *                          Node heap limit since we stream JSON files from disk).
 *   --from-api             Download the bulk dataset ZIP from LegiScan's
 *                          getDataset API. Interactive — prompts for state +
 *                          session if not provided via flags. Ceiling ~300 MB
 *                          uncompressed before Node OOM.
 *
 * Optional tenant linking:
 *   --tenant <id>          After seeding central, call POST /api/tenants/seed-session/:id
 *                          on central to create bill_tenants rows, queue keyword
 *                          matches to the ingestor, and ensure tenant.state_coverage
 *                          includes this state. Omit to leave central populated
 *                          without affecting any tenant.
 *
 * Usage (from repo root):
 *   # Local-dir seed (any size), linking to my-org:
 *   npx tsx scripts/seed-legiscan.ts \
 *     --from-dir bulkseeds/legiscan/US/2025-2026_119th_Congress \
 *     --state US --session-id 2199 \
 *     --tenant my-org --remote
 *
 *   # API download (small/medium states), interactive:
 *   npx tsx scripts/seed-legiscan.ts --from-api --tenant my-org --remote
 *
 *   # Seed central without touching any tenant:
 *   npx tsx scripts/seed-legiscan.ts --from-dir <path> --state XX --session-id N --remote
 *
 * Options:
 *   --from-dir <path>         Read bulk JSON from this directory (must contain bill/, vote/, people/)
 *   --from-api                Download dataset from LegiScan API
 *   --state <XX>              Two-letter state code (required for --from-dir; prompted for --from-api)
 *   --session-id <N>          LegiScan session_id integer (required for --from-dir; prompted for --from-api)
 *   --tenant <id>             Tenant to link bills to (skips tenant link if omitted)
 *   --local                   Use --local for wrangler + local central API
 *   --remote                  Use --remote (default)
 *   --skip-votes              Skip vote seeding entirely (no roll_calls, no roll_call_votes)
 *   --with-individual-votes   Also seed per-legislator roll_call_votes rows.
 *                             Default is to skip them — nothing in the codebase reads
 *                             them and they bloat D1 on large sessions. Use this if
 *                             you want them upfront; otherwise backfill later with
 *                             --individual-votes-only against the same JSON files.
 *   --individual-votes-only   Backfill ONLY roll_call_votes against an already-seeded
 *                             session. Skips bills/people/roll_calls. Use this to add
 *                             individual votes later without re-seeding everything.
 *   --db-name <name>          Override D1 name (default: central-bills-ls)
 *   --env <env>               Override wrangler env (default: legiscan)
 *
 * Required env vars (read from shell environment — should be in .zshrc):
 *   LEGISCAN_API_KEY          Only required for --from-api
 *   CENTRAL_ADMIN_SECRET      Only required when --tenant is set.
 *                             Also accepts ADMIN_SECRET (the name used in central/.dev.vars).
 */

import { readdirSync, readFileSync, existsSync } from 'fs'
import { unzipSync } from 'fflate'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { execSync } from 'child_process'
import * as readline from 'readline'
import { seedCentralDb, seedIndividualVotesOnly, cleanupTmpFiles, runSql, type SeedCentralDbOptions } from './lib/seed-legiscan-db.js'
import { progress, progressDone } from './lib/progress.js'

const __filename = fileURLToPath(import.meta.url)
const REPO_ROOT = join(dirname(__filename), '..')

// ── CLI args ──────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2)
let argFromDir = ''
let argFromApi = false
let argState = ''
let argSessionId = 0
let argTenant = ''  // empty = don't link to any tenant
let isRemote = true
let skipVotes = false
let withIndividualVotes = false
let individualVotesOnly = false
let argDbName = 'central-bills-ls'
let argWranglerEnv = 'legiscan'

for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === '--from-dir') argFromDir = argv[++i] ?? ''
  else if (a === '--from-api') argFromApi = true
  else if (a === '--state') argState = (argv[++i] ?? '').toUpperCase()
  else if (a === '--session-id') argSessionId = parseInt(argv[++i] ?? '0', 10)
  else if (a === '--tenant') argTenant = argv[++i] ?? ''
  else if (a === '--local') isRemote = false
  else if (a === '--remote') isRemote = true
  else if (a === '--skip-votes') skipVotes = true
  else if (a === '--with-individual-votes') withIndividualVotes = true
  else if (a === '--individual-votes-only') individualVotesOnly = true
  else if (a === '--db-name') argDbName = argv[++i] ?? argDbName
  else if (a === '--env') argWranglerEnv = argv[++i] ?? argWranglerEnv
  else { console.error(`Unknown argument: ${a}`); process.exit(1) }
}

// Mutually-exclusive vote flags
if (skipVotes && withIndividualVotes) {
  console.error('❌  --skip-votes and --with-individual-votes are mutually exclusive')
  process.exit(1)
}
if (individualVotesOnly && (skipVotes || withIndividualVotes)) {
  console.error('❌  --individual-votes-only cannot be combined with --skip-votes or --with-individual-votes')
  process.exit(1)
}
if (individualVotesOnly && !argFromDir) {
  console.error('❌  --individual-votes-only requires --from-dir (against the same JSON files used for the original seed)')
  process.exit(1)
}
if (individualVotesOnly && argTenant) {
  console.error('❌  --individual-votes-only is a central-only backfill; do not pass --tenant')
  process.exit(1)
}

// Mode validation
if (argFromDir && argFromApi) {
  console.error('❌  Pass either --from-dir or --from-api, not both')
  process.exit(1)
}
if (!argFromDir && !argFromApi) {
  console.error('❌  Required: one of --from-dir <path> or --from-api')
  console.error('    Run with --help-ish review of the file header for examples.')
  process.exit(1)
}
if (argFromDir) {
  if (!existsSync(argFromDir)) {
    console.error(`❌  --from-dir path does not exist: ${argFromDir}`)
    process.exit(1)
  }
  if (!argState || !argSessionId) {
    console.error('❌  --from-dir mode requires --state <XX> and --session-id <N>')
    process.exit(1)
  }
}

// ── Config ────────────────────────────────────────────────────────────────────

const LEGISCAN_API_KEY = process.env.LEGISCAN_API_KEY ?? ''
// Accept either CENTRAL_ADMIN_SECRET (tenant-side name) or ADMIN_SECRET (central/.dev.vars name)
const CENTRAL_ADMIN_SECRET = process.env.CENTRAL_ADMIN_SECRET ?? process.env.ADMIN_SECRET ?? ''
const CENTRAL_API_URL = isRemote
  ? (process.env.CENTRAL_API_URL ?? 'http://localhost:8787')
  : 'http://localhost:8787'
const DB_NAME = argDbName
const WRANGLER_ENV = argWranglerEnv
const LOCATION_FLAG = isRemote ? '--remote' : '--local'

if (argFromApi && !LEGISCAN_API_KEY) {
  console.error('❌  --from-api requires LEGISCAN_API_KEY env var')
  process.exit(1)
}
if (argTenant && !CENTRAL_ADMIN_SECRET) {
  console.error('❌  --tenant requires CENTRAL_ADMIN_SECRET env var (or omit --tenant)')
  process.exit(1)
}

// ── Readline helper ───────────────────────────────────────────────────────────

const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
const ask = (q: string): Promise<string> => new Promise(resolve => rl.question(q, resolve))

// ── LegiScan API ──────────────────────────────────────────────────────────────

async function legiscanFetch<T extends Record<string, unknown>>(
  op: string,
  params: Record<string, string>,
): Promise<T> {
  const url = new URL('https://api.legiscan.com/')
  url.searchParams.set('key', LEGISCAN_API_KEY)
  url.searchParams.set('op', op)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  const res = await fetch(url.toString())
  if (!res.ok) throw new Error(`LegiScan HTTP ${res.status} for ${op}`)
  const data = await res.json() as { status: string } & T
  if (data.status !== 'OK') throw new Error(`LegiScan API error (${op}): ${JSON.stringify(data)}`)
  return data
}

interface LsSession {
  session_id: number
  session_name: string
  session_title: string
  session_tag: string
  year_start: number
  year_end: number
  sine_die: number
  prior: number
  special: number
  prefile: number
  state_id: number
}

interface DatasetEntry {
  session_id: number
  state_id: number
  year_start: number
  year_end: number
  session_name: string
  dataset_hash: string
  dataset_date: string
  dataset_size: number
  access_key: string
}

async function getSessionList(state: string): Promise<LsSession[]> {
  const data = await legiscanFetch<{ sessions: Record<string, unknown> }>('getSessionList', { state })
  return Object.values(data.sessions).filter(
    (v): v is LsSession => typeof v === 'object' && v !== null && 'session_id' in v,
  )
}

async function getDatasetList(state: string): Promise<DatasetEntry[]> {
  const data = await legiscanFetch<{ datasetlist: Record<string, unknown> }>('getDatasetList', { state })
  return Object.values(data.datasetlist).filter(
    (v): v is DatasetEntry => typeof v === 'object' && v !== null && 'session_id' in v && 'access_key' in v,
  )
}

async function fetchDatasetZip(sessionId: number, accessKey: string): Promise<Uint8Array> {
  process.stdout.write(`  Downloading ZIP from LegiScan...`)
  const data = await legiscanFetch<{ dataset: { zip: string; dataset_size: number } }>(
    'getDataset',
    { id: String(sessionId), access_key: accessKey },
  )
  const bytes = Buffer.from(data.dataset.zip, 'base64')
  console.log(` ${(bytes.length / 1024 / 1024).toFixed(1)} MB`)
  return new Uint8Array(bytes)
}

// ── seed-session: link session to tenant (paginated HTTP) ─────────────────────

async function runSeedSession(tenantId: string, sessionId: number): Promise<void> {
  console.log(`\n── Linking session to "${tenantId}" via seed-session...`)
  let offset = 0
  let totalProcessed = 0
  let totalKeyword = 0

  while (true) {
    const url = `${CENTRAL_API_URL}/api/tenants/seed-session/${tenantId}?sessionId=${sessionId}&offset=${offset}&limit=500`
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'x-admin-secret': CENTRAL_ADMIN_SECRET },
    })
    if (!res.ok) {
      const body = await res.text()
      throw new Error(`seed-session HTTP ${res.status}: ${body}`)
    }
    const body = await res.json() as {
      ok: boolean
      done: boolean
      nextOffset: number | null
      processed: number
      keywordMatches: number
      nonKeyword: number
    }
    if (!body.ok) throw new Error(`seed-session returned ok:false: ${JSON.stringify(body)}`)

    totalProcessed += body.processed
    totalKeyword += body.keywordMatches
    progress(`  Processed: ${totalProcessed} (${totalKeyword} keyword matches)`)

    if (body.done) break
    offset = body.nextOffset ?? offset + 500
    // Brief pause to avoid overwhelming the queue
    await new Promise(r => setTimeout(r, 200))
  }
  progressDone(`  ✓ Done — ${totalProcessed} bills linked, ${totalKeyword} keyword matches queued to ingestor`)
  if (totalKeyword > 0) {
    console.log(`    Ingestor will download text (state_link → R2) and notify tenant for AI processing`)
  }
}

// ── ensureStateInCoverage: make sure the cron will actually poll the new state
//
// The cron only polls sessions in states listed in `tenants.state_coverage`.
// Wildcard tenants (`["*"]`) auto-cover every state with seeded sessions.
// For explicit-coverage tenants, we have to add the new state ourselves —
// otherwise the bills we just linked sit static and never refresh.
//
// Past bug: this used to be a "do it manually" comment in the script, which
// meant `seed-state-api.ts --tenant my-org --state PA` would silently
// produce a non-functional setup. Now we read the current coverage via
// wrangler d1 execute --json, and if the state is missing (and the list
// isn't wildcard), we UPDATE the row in place.
async function ensureStateInCoverage(
  tenantId: string,
  state: string,
  opts: SeedCentralDbOptions,
): Promise<void> {
  console.log(`\n── Ensuring "${state}" is in ${tenantId}.state_coverage...`)

  const cmd = `npx wrangler d1 execute ${opts.dbName} --env ${opts.wranglerEnv} ${opts.locationFlag} --json --command "SELECT state_coverage FROM tenants WHERE tenant_id = '${tenantId}'"`
  let raw: string
  try {
    raw = execSync(cmd, { cwd: join(opts.repoRoot, 'central'), stdio: ['ignore', 'pipe', 'pipe'] }).toString()
  } catch (err: any) {
    console.warn(`  ⚠️  Failed to read current state_coverage: ${err.message ?? err}. Skipping coverage update.`)
    return
  }

  // Wrangler --json wraps results in an array; pick the first result-set.
  let coverage: string[]
  try {
    const parsed = JSON.parse(raw)
    const rows = parsed?.[0]?.results
    if (!rows || rows.length === 0) {
      console.warn(`  ⚠️  Tenant "${tenantId}" not found in central D1. Skipping coverage update.`)
      return
    }
    coverage = JSON.parse(rows[0].state_coverage)
  } catch (err: any) {
    console.warn(`  ⚠️  Could not parse current state_coverage: ${err.message ?? err}. Skipping.`)
    return
  }

  if (coverage.includes('*')) {
    console.log(`  ✓ Tenant is wildcard ("*") — no update needed`)
    return
  }
  if (coverage.includes(state)) {
    console.log(`  ✓ "${state}" already in coverage [${coverage.join(', ')}]`)
    return
  }

  const updated = [...coverage, state]
  const sql = `UPDATE tenants SET state_coverage = '${JSON.stringify(updated)}' WHERE tenant_id = '${tenantId}';`
  runSql([sql], opts)
  console.log(`  ✓ Added "${state}" to coverage. New list: [${updated.join(', ')}]`)
  console.log(`    Next cron tick will start polling ${state} sessions.`)
}

// ── Main ──────────────────────────────────────────────────────────────────────

// ── Source: --from-dir ────────────────────────────────────────────────────────
// Build the same file-map shape that --from-api produces, but by streaming JSON
// files from disk. Lets us seed any-sized dataset (US, NY, TX, CA) without
// loading the whole zip into Node memory.
function buildFileMapFromDir(dir: string, state: string): { files: Record<string, Uint8Array>; sessionName: string } {
  const PREFIX = `${state}/session`  // arbitrary; seedCentralDb's regexes just need /bill/, /vote/, /people/
  const files: Record<string, Uint8Array> = {}
  let sessionName = `session ${argSessionId}`

  for (const sub of ['bill', 'vote', 'people'] as const) {
    const subDir = join(dir, sub)
    if (!existsSync(subDir)) continue
    for (const f of readdirSync(subDir)) {
      if (!f.endsWith('.json')) continue
      const buf = readFileSync(join(subDir, f))
      files[`${PREFIX}/${sub}/${f}`] = new Uint8Array(buf)
    }
  }

  // Lift the real session name from the first bill, for logging
  const firstBill = Object.entries(files).find(([k]) => /\/bill\/[^/]+\.json$/.test(k))
  if (firstBill) {
    try {
      const b = JSON.parse(new TextDecoder().decode(firstBill[1])).bill
      if (b?.session?.session_name) sessionName = b.session.session_name
    } catch { /* fall through */ }
  }

  return { files, sessionName }
}

// ── Source: --from-api ────────────────────────────────────────────────────────
async function chooseSessionInteractive(state: string): Promise<LsSession> {
  process.stdout.write(`Fetching sessions for ${state}...`)
  const sessions = await getSessionList(state)
  console.log(` ${sessions.length} found\n`)
  sessions.sort((a, b) => b.year_start - a.year_start || b.session_id - a.session_id)

  sessions.forEach((s, i) => {
    const tags: string[] = []
    if (s.sine_die) tags.push('⚑ SINE DIE')
    else tags.push('● active')
    if (s.special) tags.push('special')
    if (s.prior) tags.push('prior')
    console.log(`  [${i + 1}] ${s.session_name}  (${s.year_start}–${s.year_end})  ${tags.join('  ')}`)
  })
  console.log()

  let chosen: LsSession
  if (argSessionId) {
    const found = sessions.find(s => s.session_id === argSessionId)
    if (!found) { console.error(`Session ${argSessionId} not found for ${state}`); rl.close(); process.exit(1) }
    chosen = found
    console.log(`Session: ${chosen.session_name} (id=${chosen.session_id})`)
  } else {
    const answer = (await ask(`Select session [1–${sessions.length}]: `)).trim()
    const idx = parseInt(answer, 10) - 1
    if (isNaN(idx) || idx < 0 || idx >= sessions.length) { console.error('Invalid selection'); rl.close(); process.exit(1) }
    chosen = sessions[idx]
    console.log(`✓ ${chosen.session_name} (id=${chosen.session_id})`)
  }

  if (chosen.sine_die) {
    const proceed = (await ask(`\n⚠  This session is SINE DIE (concluded). Seed anyway? [y/N]: `)).trim().toLowerCase()
    if (proceed !== 'y') { console.log('Aborted.'); rl.close(); process.exit(0) }
  }

  return chosen
}

async function loadFromApi(state: string, chosen: LsSession): Promise<{ files: Record<string, Uint8Array>; sessionName: string }> {
  process.stdout.write('\nFetching dataset list...')
  const datasets = await getDatasetList(state)
  const dataset = datasets.find(d => d.session_id === chosen.session_id)
  if (!dataset) {
    console.error(`\nNo dataset available for session ${chosen.session_id}.`)
    console.error('LegiScan may not have a bulk export for this session yet.')
    process.exit(1)
  }
  console.log(` found`)
  console.log(`  Dataset date: ${dataset.dataset_date}`)
  console.log(`  Uncompressed size: ${(dataset.dataset_size / 1024 / 1024).toFixed(1)} MB`)
  if (dataset.dataset_size > 300 * 1024 * 1024) {
    console.warn(`  ⚠️  Large dataset; may exceed Node heap. Consider downloading manually and using --from-dir.`)
  }

  console.log('\n── Downloading dataset...')
  const zipBytes = await fetchDatasetZip(chosen.session_id, dataset.access_key)
  process.stdout.write('  Unzipping...')
  const rawFiles = unzipSync(zipBytes)
  const files: Record<string, Uint8Array> = {}
  for (const [name, data] of Object.entries(rawFiles)) files[name] = data
  console.log(` ${Object.keys(files).length} files`)
  return { files, sessionName: chosen.session_name }
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n🗺  LegiScan seeder  [${isRemote ? 'REMOTE' : 'LOCAL'}]  via ${argFromDir ? '--from-dir' : '--from-api'}`)
  if (argTenant) console.log(`   Tenant: ${argTenant}`)
  else console.log(`   Tenant: none (central only)`)
  console.log(`   Central: ${CENTRAL_API_URL}\n`)

  // ── Determine state + session, build file map ────────────────────────────
  let state = argState
  let sessionId = argSessionId
  let sessionName = ''
  let files: Record<string, Uint8Array> = {}

  if (argFromDir) {
    // Inputs already validated above
    console.log(`Source: ${argFromDir}`)
    console.log(`State: ${state}`)
    const built = buildFileMapFromDir(argFromDir, state)
    files = built.files
    sessionName = built.sessionName
    console.log(`Loaded ${Object.keys(files).length} JSON files from disk`)
  } else {
    // --from-api: interactive prompts
    if (!state) {
      const input = (await ask('State code (e.g. DC, PA): ')).trim().toUpperCase()
      if (input.length !== 2) { console.error('Invalid state code'); rl.close(); process.exit(1) }
      state = input
    } else {
      console.log(`State: ${state}`)
    }
    const chosen = await chooseSessionInteractive(state)
    sessionId = chosen.session_id
    sessionName = chosen.session_name
    rl.close()
    const built = await loadFromApi(state, chosen)
    files = built.files
  }

  // ── Seed central DB ────────────────────────────────────────────────────────
  const seedOpts: SeedCentralDbOptions = {
    repoRoot: REPO_ROOT,
    dbName: DB_NAME,
    wranglerEnv: WRANGLER_ENV,
    locationFlag: LOCATION_FLAG as '--remote' | '--local',
    skipVotes,
    includeIndividualVotes: withIndividualVotes,
  }

  // ── Backfill-only path: skip everything except roll_call_votes ──────────
  if (individualVotesOnly) {
    console.log('\n── Backfilling roll_call_votes only (skipping bills/people/roll_calls)...')
    const { voteCount, rowCount } = seedIndividualVotesOnly(files, seedOpts)
    cleanupTmpFiles()
    console.log(`\n✅ Done! ${voteCount} vote files → ${rowCount} roll_call_votes rows written.`)
    return
  }

  console.log('\n── Seeding central DB...')
  const { billCount, errorCount } = seedCentralDb(files, state, sessionId, seedOpts)

  // ── Optional: link to tenant ─────────────────────────────────────────────
  if (argTenant) {
    await runSeedSession(argTenant, sessionId)
    await ensureStateInCoverage(argTenant, state, seedOpts)
  } else {
    console.log('\n  No --tenant specified; central is seeded but bill_tenants rows were not created.')
    console.log(`  To link later: POST ${CENTRAL_API_URL}/api/tenants/seed-session/<tenantId>?sessionId=${sessionId}`)
  }

  cleanupTmpFiles()

  console.log(`\n✅ Done!`)
  console.log(`   ${billCount} bills seeded into central for ${state} → ${sessionName}`)
  if (argTenant) {
    console.log(`   Keyword-matching bills: queued to ingestor (downloads text → R2, then AI via tenant)`)
    console.log(`   Non-keyword bills: land as stubs in ${argTenant} (metadata only, no AI)`)
  }

  // Release the readline handle opened at module load so the process exits.
  // The --from-dir path never prompts, so nothing else closes it, and the open
  // stdin handle would otherwise keep the event loop alive after we're done.
  rl.close()

  // A batch-level D1 failure now aborts mid-run (via the throw in seedCentralDb),
  // so reaching here means every batch committed. errorCount only counts per-bill
  // build failures (malformed JSON) — still an incomplete seed, so exit non-zero
  // instead of letting "✅ Done" imply a full seed.
  if (errorCount > 0) {
    console.error(`\n⚠️  ${errorCount} bill file(s) failed to build and were skipped — seed is INCOMPLETE. Re-run to retry (idempotent).`)
    process.exit(1)
  }
}

main().catch(err => {
  cleanupTmpFiles()
  rl.close()
  console.error('\n❌', (err as Error).message ?? err)
  process.exit(1)
})
