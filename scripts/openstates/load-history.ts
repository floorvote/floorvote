#!/usr/bin/env tsx
/**
 * load-history.ts — Local replacement for the central Worker's /admin/load-history endpoint.
 *
 * Downloads LegiScan dataset ZIPs locally (no Worker CPU involvement), seeds central D1 with
 * bills and bill_tenants rows, then prints the reingest-tenant command to run next.
 *
 * Usage (from repo root):
 *   npx tsx scripts/openstates/load-history.ts --state NJ
 *   npx tsx scripts/openstates/load-history.ts --state NJ --sessions-back 2
 *   npx tsx scripts/openstates/load-history.ts --state NJ --session-ids 2214,2238
 *   npx tsx scripts/openstates/load-history.ts --state NJ --force
 *   npx tsx scripts/openstates/load-history.ts --list-sessions NJ
 *
 * Reads LEGISCAN_API_KEY and ADMIN_SECRET from central/.dev.vars or environment.
 * Requires: wrangler authenticated (npx wrangler login)
 */

import { execSync } from 'child_process'
import { writeFileSync, unlinkSync, existsSync, readFileSync } from 'fs'
import { unzipSync } from 'fflate'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const REPO_ROOT = join(dirname(__filename), '..')
const CENTRAL_DB = 'central-bills'

// ── Load env ──────────────────────────────────────────────────────────────────

function loadDevVars(): Record<string, string> {
  const p = join(REPO_ROOT, 'central', '.dev.vars')
  if (!existsSync(p)) return {}
  const vars: Record<string, string> = {}
  for (const line of readFileSync(p, 'utf-8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.+)$/)
    if (m) vars[m[1]] = m[2].trim()
  }
  return vars
}

const env = loadDevVars()
const LEGISCAN_API_KEY = process.env.LEGISCAN_API_KEY ?? env.LEGISCAN_API_KEY ?? ''
const CENTRAL_URL = process.env.CENTRAL_URL ?? 'http://localhost:8787'

if (!LEGISCAN_API_KEY) {
  console.error('Error: LEGISCAN_API_KEY not found in env or central/.dev.vars')
  process.exit(1)
}

// ── Parse args ────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2)
let state = ''
let listSessionsState = ''
let sessionsBack = 1
let sessionIds: number[] = []
let force = false

for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === '--state') state = (argv[++i] ?? '').toUpperCase()
  else if (a === '--sessions-back') sessionsBack = parseInt(argv[++i] ?? '1')
  else if (a === '--session-ids') sessionIds = (argv[++i] ?? '').split(',').map(Number).filter(Boolean)
  else if (a === '--force') force = true
  else if (a === '--list-sessions') listSessionsState = (argv[++i] ?? '').toUpperCase()
  else { console.error(`Unknown argument: ${a}`); process.exit(1) }
}

if (!state && !listSessionsState) {
  console.error('Usage: npx tsx scripts/openstates/load-history.ts --state STATE [--sessions-back N] [--session-ids ID,ID] [--force]')
  console.error('       npx tsx scripts/openstates/load-history.ts --list-sessions STATE')
  process.exit(1)
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function esc(s: string | number | null | undefined): string {
  if (s == null) return 'NULL'
  return `'${String(s).replace(/'/g, "''")}'`
}

// Numeric SQL literal — interpolated UNQUOTED, so validate strictly and throw on
// a non-finite/non-numeric value rather than emit raw SQL. The bulk
// JSON is untyped, so a malformed/crafted file could otherwise inject via a
// numeric column.
function num(v: number | string | null | undefined): string {
  if (v == null) return 'NULL'
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) {
    throw new Error(`num(): expected a finite number, got ${JSON.stringify(v)}`)
  }
  return String(n)
}

async function legiscanFetch<T>(op: string, params: Record<string, string>): Promise<T> {
  const url = new URL('https://api.legiscan.com/')
  url.searchParams.set('key', LEGISCAN_API_KEY)
  url.searchParams.set('op', op)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  const res = await fetch(url.toString())
  if (!res.ok) throw new Error(`LegiScan HTTP ${res.status}`)
  const data = (await res.json()) as { status: string } & T
  if (data.status !== 'OK') throw new Error(`LegiScan error: ${JSON.stringify(data)}`)
  return data
}

function d1Query(sql: string): any[] {
  const out = execSync(
    `npx wrangler d1 execute ${CENTRAL_DB} --remote --json --command ${JSON.stringify(sql)}`,
    { cwd: REPO_ROOT, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
  )
  // Strip wrangler banner before the JSON array
  const jsonStart = out.indexOf('[')
  if (jsonStart === -1) throw new Error(`Unexpected wrangler output: ${out.slice(0, 200)}`)
  return JSON.parse(out.slice(jsonStart))[0]?.results ?? []
}

function d1ExecuteFile(sqlFile: string): void {
  execSync(
    `npx wrangler d1 execute ${CENTRAL_DB} --remote --file ${JSON.stringify(sqlFile)}`,
    { cwd: REPO_ROOT, stdio: 'inherit' }
  )
}

const WORD_BOUNDARY_KEYWORDS = new Set(['election'])

function matchesUnion(text: string, keywords: string[]): { matched: boolean; keyword: string } {
  const lower = text.toLowerCase()
  for (const kw of keywords) {
    if (WORD_BOUNDARY_KEYWORDS.has(kw)) {
      const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      if (new RegExp(`(?<![a-zA-Z])${escaped}`, 'i').test(lower)) return { matched: true, keyword: kw }
    } else {
      if (lower.includes(kw.toLowerCase())) return { matched: true, keyword: kw }
    }
  }
  return { matched: false, keyword: '' }
}

// ── List sessions ─────────────────────────────────────────────────────────────

async function listSessions(st: string): Promise<void> {
  console.error(`Fetching sessions for ${st}...`)
  const data = await legiscanFetch<{ datasetlist: Record<string, any> }>('getDatasetList', { state: st })
  const sessions = Object.values(data.datasetlist)
    .filter((v: any) => v && typeof v === 'object' && 'session_id' in v)
    .sort((a: any, b: any) => b.year_start - a.year_start || b.session_id - a.session_id) as any[]

  console.log(`\nAvailable sessions for ${st}:`)
  console.log('  session_id  year   name                          size')
  console.log('  ----------  -----  ----------------------------  --------')
  for (const s of sessions) {
    const size = `${Math.round(s.dataset_size / 1024)}KB`
    console.log(`  ${String(s.session_id).padEnd(10)}  ${s.year_start}  ${s.session_name.padEnd(28)}  ${size}`)
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  if (listSessionsState) {
    await listSessions(listSessionsState)
    return
  }

  // SQLite space-format UTC ("YYYY-MM-DD HH:MM:SS"), NOT ISO — these land in the central
  // bills.created_at / updated_at columns, which default to datetime('now'). Mixing ISO and
  // space formats in one column breaks ORDER BY/MAX (idx_bills_updated). See
  // docs/date-format-convention.md.
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ')

  // Query active tenants covering this state
  console.error(`Querying central for tenants covering ${state}...`)
  const tenantRows = d1Query(`SELECT tenant_id, state_coverage FROM tenants WHERE active = 1`)
  const matchingTenants = tenantRows.filter((t: any) => {
    const coverage: string[] = JSON.parse(t.state_coverage)
    return coverage.includes('*') || coverage.includes(state)
  })
  if (matchingTenants.length === 0) {
    console.error(`Warning: no active tenants cover ${state}. Bills will be inserted into central but no bill_tenants rows created.`)
  } else {
    console.error(`  ${matchingTenants.length} tenant(s): ${matchingTenants.map((t: any) => t.tenant_id).join(', ')}`)
  }

  // Query keyword union
  console.error('Querying keyword union...')
  const keywordRows = d1Query(`SELECT DISTINCT keyword FROM keyword_registry`)
  const keywords = keywordRows.map((r: any) => r.keyword as string)
  console.error(`  ${keywords.length} keywords in union`)

  // Fetch dataset list
  console.error(`\nFetching dataset list for ${state}...`)
  const listData = await legiscanFetch<{ datasetlist: Record<string, any> }>('getDatasetList', { state })
  const allSessions = Object.values(listData.datasetlist)
    .filter((v: any) => v && typeof v === 'object' && 'session_id' in v)
    .sort((a: any, b: any) => b.year_start - a.year_start || b.session_id - a.session_id) as any[]

  const sessions = sessionIds.length
    ? allSessions.filter((s: any) => sessionIds.includes(s.session_id))
    : allSessions.slice(0, sessionsBack)

  if (sessions.length === 0) {
    console.error('No sessions found matching the given criteria.')
    process.exit(1)
  }
  console.error(`  ${sessions.length} session(s): ${sessions.map((s: any) => s.session_name).join(', ')}`)

  // Query stored dataset hashes to skip unchanged sessions
  const storedRows = d1Query(`SELECT session_id, dataset_hash FROM legi_sessions WHERE state = ${esc(state)}`)
  const storedHashes = new Map(storedRows.map((r: any) => [r.session_id, r.dataset_hash]))

  let totalBills = 0
  let totalMatched = 0
  let totalSkipped = 0

  for (const session of sessions) {
    const storedHash = storedHashes.get(session.session_id)
    if (!force && storedHash === session.dataset_hash) {
      console.error(`\nSkipping ${session.session_name} — dataset unchanged (hash=${session.dataset_hash})`)
      totalSkipped++
      continue
    }

    const sizeMb = (session.dataset_size / 1024 / 1024).toFixed(1)
    console.error(`\nProcessing ${session.session_name} (${state}, id=${session.session_id}, ${sizeMb}MB)...`)
    console.error('  Downloading ZIP...')

    const zipData = await legiscanFetch<{ dataset: { zip: string } }>(
      'getDataset',
      { id: String(session.session_id), access_key: session.access_key, format: 'json' }
    )
    const zipBytes = Buffer.from(zipData.dataset.zip, 'base64')
    console.error(`  Unzipping (${(zipBytes.length / 1024 / 1024).toFixed(1)}MB)...`)

    const files = unzipSync(new Uint8Array(zipBytes))
    const billFiles = Object.keys(files).filter(f => f.endsWith('.json') && f.includes('/bill/'))
    console.error(`  ${billFiles.length} bills found, matching keywords...`)

    const statements: string[] = []
    let sessionMatched = 0

    for (const filename of billFiles) {
      let billData: any
      try {
        billData = JSON.parse(Buffer.from(files[filename]).toString('utf-8'))
        if (billData.bill) billData = billData.bill
      } catch { continue }

      const billId = billData.bill_id
      if (!billId) continue
      totalBills++

      // INSERT OR IGNORE: don't overwrite bills already in central (they may have full_json + textR2Key)
      statements.push(
        `INSERT OR IGNORE INTO bills (bill_id, session_id, state, number, title, description, status, status_date, change_hash, url, created_at, updated_at) ` +
        `VALUES (${num(billId)}, ${num(session.session_id)}, ${esc(state)}, ${esc(billData.bill_number ?? '')}, ` +
        `${esc(billData.title ?? '')}, ${esc(billData.description ?? '')}, ` +
        `${num(billData.status ?? null)}, ${esc(billData.status_date)}, ` +
        `${esc(billData.change_hash ?? '')}, ${esc(billData.url)}, ${esc(now)}, ${esc(now)});`
      )

      // Match keywords → bill_tenants rows
      const text = `${billData.title ?? ''} ${billData.description ?? ''}`
      const { matched, keyword } = matchesUnion(text, keywords)
      if (matched) {
        sessionMatched++
        totalMatched++
        for (const tenant of matchingTenants) {
          statements.push(
            `INSERT OR IGNORE INTO bill_tenants (bill_id, tenant_id, matched_keyword) ` +
            `VALUES (${billId}, ${esc(tenant.tenant_id)}, ${esc(keyword)});`
          )
        }
      }
    }

    // Record the session so future runs can skip it when dataset_hash is unchanged
    statements.push(
      `INSERT INTO legi_sessions (session_id, state, year_start, year_end, session_name, is_current, sine_die, dataset_hash) ` +
      `VALUES (${session.session_id}, ${esc(state)}, ${session.year_start}, ${session.year_end}, ` +
      `${esc(session.session_name)}, 0, 1, ${esc(session.dataset_hash)}) ` +
      `ON CONFLICT(session_id) DO UPDATE SET dataset_hash = excluded.dataset_hash;`
    )

    console.error(`  ${sessionMatched} matched, writing ${statements.length} SQL statements...`)

    const tmpFile = join(tmpdir(), `load-history-${state}-${session.session_id}-${Date.now()}.sql`)
    writeFileSync(tmpFile, statements.join('\n'))
    try {
      d1ExecuteFile(tmpFile)
      console.error(`  ✓ ${session.session_name} done`)
    } finally {
      try { unlinkSync(tmpFile) } catch {}
    }
  }

  console.error(`\n✓ Done: ${totalBills} bills processed, ${totalMatched} matched, ${totalSkipped} session(s) unchanged`)

  if (matchingTenants.length > 0) {
    console.error('\nTrigger reingest to push matched bills to tenant queues:')
    for (const tenant of matchingTenants) {
      console.error(`  curl -X POST ${CENTRAL_URL}/admin/reingest-tenant/${tenant.tenant_id} \\`)
      console.error(`    -H "x-admin-secret: <ADMIN_SECRET>"`)
    }
  }
}

main().catch(e => { console.error(e); process.exit(1) })
