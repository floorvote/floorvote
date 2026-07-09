#!/usr/bin/env tsx
/**
 * seed-session-people.ts — Seeds/refreshes the central LegiScan `people` table.
 *
 * Fetches all legislators for a session via getSessionPeople (1 API call), then
 * INSERTs each with ON CONFLICT DO UPDATE. Unlike update-people-bio-json.ts
 * (which only touches bio_json on rows that already exist), this creates rows
 * that are missing entirely — the backfill path for a state that was onboarded
 * via keyword sync rather than a bulk dataset seed, whose sponsors otherwise
 * render as numeric people_ids.
 *
 * Display fields (name, party, role, district, ...) are refreshed on conflict;
 * bio_json is preserved (only bulk/getSessionPeople-bio sources populate it).
 *
 * Usage (from repo root):
 *   npx tsx scripts/seed-session-people.ts \
 *     --session-id 2197 \
 *     --api-key <LEGISCAN_API_KEY> \
 *     --db-name central-bills-ls \
 *     --env legiscan \
 *     --remote
 *
 * Defaults to --local. Pass multiple --session-id flags to seed several sessions.
 */

import { execSync } from 'child_process'
import { writeFileSync, unlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const REPO_ROOT = join(dirname(__filename), '..')

// ── Parse args ────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2)
const sessionIds: number[] = []
let apiKey = ''
let dbName = 'central-bills-ls'
let wranglerEnv = 'legiscan'
let isLocal = true

for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === '--session-id') sessionIds.push(parseInt(argv[++i] ?? '0', 10))
  else if (a === '--api-key') apiKey = argv[++i] ?? ''
  else if (a === '--db-name') dbName = argv[++i] ?? ''
  else if (a === '--env') wranglerEnv = argv[++i] ?? ''
  else if (a === '--local') isLocal = true
  else if (a === '--remote') isLocal = false
  else { console.error(`Unknown argument: ${a}`); process.exit(1) }
}

apiKey = apiKey || process.env.LEGISCAN_API_KEY || ''

if (sessionIds.length === 0 || !apiKey) {
  console.error('Usage: npx tsx scripts/seed-session-people.ts --session-id <id> [--session-id <id> ...] --api-key <key> [--db-name <name>] [--env <env>] [--local|--remote]')
  console.error('       (LEGISCAN_API_KEY env var can be used instead of --api-key)')
  process.exit(1)
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function esc(v: string | number | null | undefined): string {
  if (v == null || v === '') return 'NULL'
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL'
  return `'${String(v).replace(/'/g, "''")}'`
}

function runSql(statements: string[]): void {
  if (statements.length === 0) return

  const sql = statements.join('\n')
  const tmpFile = join(tmpdir(), `seed-people-${Date.now()}-${Math.random().toString(36).slice(2)}.sql`)
  writeFileSync(tmpFile, sql, 'utf-8')

  const envFlag = wranglerEnv ? `--env ${wranglerEnv}` : ''
  const localFlag = isLocal ? '--local' : '--remote'
  const cmd = `npx wrangler d1 execute ${dbName} ${envFlag} ${localFlag} --file ${tmpFile}`

  try {
    execSync(cmd, { stdio: 'pipe', cwd: join(REPO_ROOT, 'central') })
  } catch (err: any) {
    const stderr = err.stderr?.toString() ?? ''
    const stdout = err.stdout?.toString() ?? ''
    console.error(`  [wrangler error] ${stderr || stdout}`)
    throw new Error('SQL execution failed — aborting')
  } finally {
    try { unlinkSync(tmpFile) } catch {}
  }
}

function runInChunks(statements: string[], chunkSize = 50): void {
  for (let i = 0; i < statements.length; i += chunkSize) {
    const chunk = statements.slice(i, i + chunkSize)
    process.stdout.write(`  rows ${i + 1}–${Math.min(i + chunkSize, statements.length)} of ${statements.length}...\r`)
    runSql(chunk)
  }
  process.stdout.write('\n')
}

// Column list matches central/src/db/schema-legiscan.ts `people` (bio_json omitted:
// preserved on conflict). Keep in sync with the ingest upsert in processor-legiscan.ts.
const COLS = [
  'people_id', 'person_hash', 'state_id', 'party_id', 'party', 'role_id', 'role',
  'name', 'first_name', 'middle_name', 'last_name', 'suffix', 'nickname', 'district',
  'ftm_eid', 'votesmart_id', 'opensecrets_id', 'knowwho_pid', 'ballotpedia', 'bioguide_id',
] as const

function buildUpsert(p: any): string | null {
  if (!p.people_id) return null
  const values: Record<string, string> = {
    people_id:      esc(p.people_id),
    person_hash:    esc(p.person_hash),
    state_id:       esc(p.state_id),
    party_id:       esc(p.party_id),
    party:          esc(p.party),
    role_id:        esc(p.role_id),
    role:           esc(p.role),
    name:           esc(p.name || String(p.people_id)),
    first_name:     esc(p.first_name),
    middle_name:    esc(p.middle_name),
    last_name:      esc(p.last_name),
    suffix:         esc(p.suffix),
    nickname:       esc(p.nickname),
    district:       esc(p.district),
    ftm_eid:        esc(p.ftm_eid),
    votesmart_id:   esc(p.votesmart_id),
    opensecrets_id: esc(p.opensecrets_id),
    knowwho_pid:    esc(p.knowwho_pid),
    ballotpedia:    esc(p.ballotpedia),
    bioguide_id:    esc(p.bioguide_id),
  }
  const colList = COLS.join(', ')
  const valList = COLS.map(c => values[c]).join(', ')
  // Refresh every column except the primary key on conflict; bio_json is never
  // in the column list, so an existing row's bio_json survives untouched.
  const updates = COLS.filter(c => c !== 'people_id').map(c => `${c} = excluded.${c}`).join(', ')
  return `INSERT INTO people (${colList}) VALUES (${valList}) ON CONFLICT(people_id) DO UPDATE SET ${updates};`
}

// ── Main ────────────────────────────────────────────────────────────────────

async function seedSession(sessionId: number): Promise<void> {
  console.log(`\nFetching getSessionPeople for session ${sessionId}...`)
  const url = `https://api.legiscan.com/?key=${apiKey}&op=getSessionPeople&id=${sessionId}`

  const res = await fetch(url)
  if (!res.ok) {
    console.error(`HTTP error: ${res.status} ${res.statusText}`)
    process.exit(1)
  }

  const data = await res.json() as any
  if (data.status !== 'OK') {
    console.error('LegiScan API error:', JSON.stringify(data))
    process.exit(1)
  }

  const people: any[] = data.sessionpeople?.people ?? []
  console.log(`  Got ${people.length} people.`)
  if (people.length === 0) {
    console.log('  Nothing to seed for this session.')
    return
  }

  const upserts = people.map(buildUpsert).filter((s): s is string => s !== null)
  console.log(`  ${upserts.length} upsert statements.`)
  console.log('  Sample:', (upserts[0] ?? '').slice(0, 160) + '…')

  runInChunks(upserts, 50)
  console.log(`  Done: upserted ${upserts.length} people for session ${sessionId}.`)
}

async function main() {
  const target = isLocal ? 'LOCAL' : 'REMOTE'
  console.log(`Seeding people into ${dbName} (${target}, env=${wranglerEnv}) for sessions: ${sessionIds.join(', ')}`)
  for (const sessionId of sessionIds) {
    await seedSession(sessionId)
  }
  console.log('\nAll sessions seeded.')
}

main().catch(err => { console.error(err); process.exit(1) })
