#!/usr/bin/env tsx
/**
 * update-people-bio-json.ts — Backfills bio_json in central LegiScan people table.
 *
 * Fetches all legislators for a session via getSessionPeople (1 API call),
 * then UPDATEs people SET bio_json = <bio> WHERE people_id = <id> for each.
 *
 * Usage (from repo root):
 *   npx tsx scripts/update-people-bio-json.ts \
 *     --session-id 2250 \
 *     --api-key <LEGISCAN_API_KEY> \
 *     --db-name central-bills-ls \
 *     --env legiscan \
 *     --remote
 *
 * Defaults to --local. Always creates a backup table before updating.
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
let sessionId = 0
let apiKey = ''
let dbName = 'central-bills-ls'
let wranglerEnv = 'legiscan'
let isLocal = true

for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === '--session-id') sessionId = parseInt(argv[++i] ?? '0', 10)
  else if (a === '--api-key') apiKey = argv[++i] ?? ''
  else if (a === '--db-name') dbName = argv[++i] ?? ''
  else if (a === '--env') wranglerEnv = argv[++i] ?? ''
  else if (a === '--local') isLocal = true
  else if (a === '--remote') isLocal = false
  else { console.error(`Unknown argument: ${a}`); process.exit(1) }
}

apiKey = apiKey || process.env.LEGISCAN_API_KEY || ''

if (!sessionId || !apiKey) {
  console.error('Usage: npx tsx scripts/update-people-bio-json.ts --session-id <id> --api-key <key> [--db-name <name>] [--env <env>] [--local|--remote]')
  console.error('       (LEGISCAN_API_KEY env var can be used instead of --api-key)')
  process.exit(1)
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function esc(v: string | null | undefined): string {
  if (v == null) return 'NULL'
  return `'${String(v).replace(/'/g, "''")}'`
}

function runSql(statements: string[]): void {
  if (statements.length === 0) return

  const sql = statements.join('\n')
  const tmpFile = join(tmpdir(), `bio-update-${Date.now()}-${Math.random().toString(36).slice(2)}.sql`)
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

// ── 1. Backup ─────────────────────────────────────────────────────────────────

const today = new Date().toISOString().slice(0, 10).replace(/-/g, '')
const backupTable = `people_backup_${today}`

console.log(`Creating backup table: ${backupTable}...`)
runSql([`CREATE TABLE IF NOT EXISTS ${backupTable} AS SELECT * FROM people;`])
console.log('  Backup created.')

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  // ── 2. Fetch getSessionPeople ───────────────────────────────────────────────

  console.log(`Fetching getSessionPeople for session ${sessionId}...`)
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
    console.log('No people returned — nothing to update.')
    process.exit(0)
  }

  // ── 3. Verify people_ids exist in DB ───────────────────────────────────────

  const ids = people.map((p: any) => p.people_id).filter(Boolean)
  console.log(`  people_ids in response: ${ids.length} (sample: ${ids.slice(0, 5).join(', ')})`)

  // ── 4. Build UPDATE statements ─────────────────────────────────────────────

  console.log('Building UPDATE statements...')

  const updates: string[] = []
  let skipped = 0

  for (const p of people) {
    const { people_id, bio } = p
    if (!people_id) { skipped++; continue }
    const bioJson = esc(JSON.stringify(bio ?? null))
    updates.push(`UPDATE people SET bio_json = ${bioJson} WHERE people_id = ${people_id};`)
  }

  if (skipped > 0) console.log(`  Skipped ${skipped} entries with no people_id.`)
  console.log(`  ${updates.length} UPDATE statements to run.`)

  // ── 5. Safety check ────────────────────────────────────────────────────────

  console.log('\nSample statement (first person):')
  const sample = updates[0] ?? ''
  console.log(' ', sample.slice(0, 200) + (sample.length > 200 ? '…' : ''))

  // ── 6. Run updates ─────────────────────────────────────────────────────────

  console.log('\nRunning updates...')
  runInChunks(updates, 50)

  console.log(`\nDone. Updated bio_json for ${updates.length} people.`)
  console.log(`Backup preserved as: ${backupTable}`)
}

main().catch(err => { console.error(err); process.exit(1) })
