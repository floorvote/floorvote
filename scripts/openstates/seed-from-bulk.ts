#!/usr/bin/env tsx
/**
 * seed-from-bulk.ts — Seeds central D1 + R2 from an OpenStates bulk JSON download.
 *
 * Usage (from repo root):
 *   npx tsx scripts/openstates/seed-from-bulk.ts \
 *     --dir scripts/RI_2026_json_1Tz9LLFk1vvFvQPvsq3kpV \
 *     --state RI --tenant-id my-org \
 *     --keywords "election,voter,ballot"
 *
 *   npx tsx scripts/openstates/seed-from-bulk.ts \
 *     --zip ~/Downloads/RI_2026.zip \
 *     --state RI --tenant-id ri \
 *     --keywords-file scripts/ri-keywords.txt
 *
 *   npx tsx scripts/openstates/seed-from-bulk.ts --dir ... --state RI --dry-run
 *
 * Reads ADMIN_SECRET from central/.dev.vars or environment.
 * Requires: wrangler authenticated (npx wrangler login)
 */

import { execSync } from 'child_process'
import { writeFileSync, unlinkSync, existsSync, readFileSync, readdirSync, statSync, mkdirSync } from 'fs'
import { unzipSync } from 'fflate'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { createHash } from 'crypto'

const __filename = fileURLToPath(import.meta.url)
const REPO_ROOT = join(dirname(__filename), '..', '..')
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

const envVars = loadDevVars()
const ADMIN_SECRET = process.env.ADMIN_SECRET ?? envVars.ADMIN_SECRET ?? ''
const CENTRAL_URL = process.env.CENTRAL_URL ?? 'http://localhost:8787'

if (!ADMIN_SECRET) {
  console.error('Error: ADMIN_SECRET not found in env or central/.dev.vars')
  process.exit(1)
}

// ── Parse args ────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2)
let dir = ''
let zipPath = ''
let state = ''
let tenantId = ''
let sessionId = ''
let keywords: string[] = []
let keywordsFile = ''
let dryRun = false

for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === '--dir') dir = argv[++i] ?? ''
  else if (a === '--zip') zipPath = argv[++i] ?? ''
  else if (a === '--state') state = (argv[++i] ?? '').toUpperCase()
  else if (a === '--tenant-id') tenantId = argv[++i] ?? ''
  else if (a === '--session-id') sessionId = argv[++i] ?? ''
  else if (a === '--keywords') keywords = (argv[++i] ?? '').split(',').map(s => s.trim()).filter(Boolean)
  else if (a === '--keywords-file') keywordsFile = argv[++i] ?? ''
  else if (a === '--dry-run') dryRun = true
  else { console.error(`Unknown argument: ${a}`); process.exit(1) }
}

if (!dir && !zipPath) {
  console.error('Usage: npx tsx scripts/seed-from-bulk.ts --dir DIR [--state XX] [--tenant-id ID] [--keywords kw1,kw2] [--dry-run]')
  console.error('       npx tsx scripts/seed-from-bulk.ts --zip FILE.zip [--state XX] [--tenant-id ID] [--keywords kw1,kw2]')
  process.exit(1)
}

if (keywordsFile) {
  keywords = readFileSync(keywordsFile, 'utf-8').split('\n').map(s => s.trim()).filter(Boolean)
}

// ── Bulk JSON types ───────────────────────────────────────────────────────────

interface BulkAction {
  organization__name: string
  description: string
  date: string
  classification: string[]
  order: number
}

interface BulkVersion {
  note: string
  date: string
  links: Array<{ url: string; media_type: string }>
}

interface BulkBill {
  id: string
  legislative_session: string
  identifier: string
  title: string
  abstracts: Array<{ abstract: string; note: string }>
  actions: BulkAction[]
  sponsors: Array<{ name: string; primary: boolean; classification: string }>
  versions: BulkVersion[]
  documents: BulkVersion[]
  sources: Array<{ url: string }>
  votes: unknown[]
  related_bills: unknown[]
  raw_text: string
  raw_text_url: string
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function esc(s: string | number | null | undefined): string {
  if (s == null) return 'NULL'
  return `'${String(s).replace(/'/g, "''")}'`
}

function d1Query(sql: string): Record<string, unknown>[] {
  const out = execSync(
    `npx wrangler d1 execute ${CENTRAL_DB} --remote --json --command ${JSON.stringify(sql)}`,
    { cwd: REPO_ROOT, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
  )
  const jsonStart = out.indexOf('[')
  if (jsonStart === -1) throw new Error(`Unexpected wrangler output: ${out.slice(0, 200)}`)
  return (JSON.parse(out.slice(jsonStart))[0] as any)?.results ?? []
}

function d1ExecuteFile(sqlFile: string): void {
  execSync(
    `npx wrangler d1 execute ${CENTRAL_DB} --remote --file ${JSON.stringify(sqlFile)}`,
    { cwd: REPO_ROOT, stdio: 'inherit' },
  )
}

const WORD_BOUNDARY_KEYWORDS = new Set(['election'])

function kwMatch(text: string, kws: string[]): { matched: boolean; keyword: string } {
  const lower = text.toLowerCase()
  for (const kw of kws) {
    if (WORD_BOUNDARY_KEYWORDS.has(kw)) {
      const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      if (new RegExp(`(?<![a-zA-Z])${escaped}`, 'i').test(lower)) return { matched: true, keyword: kw }
    } else {
      if (lower.includes(kw.toLowerCase())) return { matched: true, keyword: kw }
    }
  }
  return { matched: false, keyword: '' }
}

function syntheticVersionId(v: BulkVersion, index: number): string {
  const key = (v.links[0]?.url ?? '') + v.note + String(index)
  return createHash('sha256').update(key).digest('hex').slice(0, 8)
}

// ── Find bills JSON within a directory ───────────────────────────────────────

function findBillsJson(baseDir: string): string {
  function recurse(d: string, depth: number): string | null {
    if (depth > 3) return null
    for (const entry of readdirSync(d)) {
      const full = join(d, entry)
      if (entry.endsWith('_bills.json')) return full
      if (statSync(full).isDirectory()) {
        const found = recurse(full, depth + 1)
        if (found) return found
      }
    }
    return null
  }
  const found = recurse(baseDir, 0)
  if (!found) throw new Error(`No *_bills.json file found under ${baseDir}`)
  return found
}

// ── Detect state from path ────────────────────────────────────────────────────

function detectState(path: string): string {
  const m = path.match(/[\/\\]([A-Z]{2})[\/\\]\d{4}[\/\\]/) ??
            path.match(/[\/\\]([A-Z]{2})_\d{4}/)
  return m?.[1] ?? ''
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  // SQLite space-format UTC ("YYYY-MM-DD HH:MM:SS"), NOT ISO — these land in the central
  // bills.created_at / updated_at columns, which default to datetime('now'). Mixing ISO and
  // space formats in one column breaks ORDER BY/MAX (idx_bills_updated). See
  // docs/date-format-convention.md.
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ')
  let workDir = dir ? (dir.startsWith('/') ? dir : join(REPO_ROOT, dir)) : ''

  // Handle ZIP
  let tmpWorkDir: string | null = null
  if (zipPath) {
    console.error('Extracting ZIP...')
    const zipBytes = readFileSync(zipPath)
    const files = unzipSync(new Uint8Array(zipBytes))
    tmpWorkDir = join(tmpdir(), `seed-bulk-${Date.now()}`)
    mkdirSync(tmpWorkDir, { recursive: true })
    for (const [filePath, data] of Object.entries(files)) {
      const outPath = join(tmpWorkDir, filePath)
      mkdirSync(dirname(outPath), { recursive: true })
      writeFileSync(outPath, data)
    }
    workDir = tmpWorkDir
    console.error(`  Extracted to ${workDir}`)
  }

  try {
    // Find bills JSON
    const billsJsonPath = findBillsJson(workDir)
    console.error(`Reading ${billsJsonPath}...`)

    // Auto-detect state
    if (!state) {
      state = detectState(billsJsonPath)
      if (state) console.error(`  Auto-detected state: ${state}`)
      else { console.error('Error: --state is required (could not auto-detect from path)'); process.exit(1) }
    }

    const bills: BulkBill[] = JSON.parse(readFileSync(billsJsonPath, 'utf-8'))
    const sessionIdentifier = String(bills[0]?.legislative_session ?? '')
    if (!sessionIdentifier) {
      console.error('Error: could not determine session identifier from bulk JSON')
      process.exit(1)
    }

    console.error(`  ${bills.length} bills, session identifier: ${sessionIdentifier}, state: ${state}`)

    // Resolve session ID
    let resolvedSessionId = sessionId
    if (!resolvedSessionId) {
      if (!dryRun) {
        const rows = d1Query(
          `SELECT session_id FROM sessions WHERE state = ${esc(state)} AND identifier = ${esc(sessionIdentifier)} LIMIT 1`,
        )
        resolvedSessionId = (rows[0]?.session_id as string | undefined) ?? `seed:${state}:${sessionIdentifier}`
        console.error(`  Session ID: ${resolvedSessionId} (${rows.length ? 'found in central DB' : 'synthesized'})`)
      } else {
        resolvedSessionId = `seed:${state}:${sessionIdentifier}`
        console.error(`  Session ID: ${resolvedSessionId} (synthesized for dry-run)`)
      }
    }

    const year = parseInt(sessionIdentifier, 10) || new Date().getFullYear()

    console.error(`Matching keywords (${keywords.length > 0 ? keywords.length + ' provided' : 'none — all bills get bill_tenants if tenant-id set'})...`)

    const statements: string[] = []
    const textsToUpload: Array<{ billId: string; url: string; mediaType: string } | { billId: string; rawText: string }> = []
    let kwMatchCount = 0

    // Upsert session
    statements.push(
      `INSERT INTO sessions (session_id, state, identifier, year_start, year_end, session_name, classification, is_current, sine_die, provider) ` +
      `VALUES (${esc(resolvedSessionId)}, ${esc(state)}, ${esc(sessionIdentifier)}, ${year}, ${year}, ` +
      `COALESCE((SELECT session_name FROM sessions WHERE session_id = ${esc(`${state.toLowerCase()}:${sessionIdentifier}`)}), ${esc(`${sessionIdentifier} Regular Session`)}), 'primary', 0, 0, 'openstates') ` +
      `ON CONFLICT(session_id) DO NOTHING;`,
    )

    for (const bill of bills) {
      const lastAction = [...bill.actions].sort((a, b) => b.order - a.order)[0] ?? null
      const abstract = bill.abstracts[0]?.abstract ?? null

      const normalizedVersions = bill.versions.map((v, i) => ({
        id: syntheticVersionId(v, i),
        note: v.note,
        date: v.date,
        links: v.links.map(l => ({ url: l.url, mediaType: l.media_type })),
      }))
      const normalizedDocuments = (bill.documents ?? []).map((d, i) => ({
        id: syntheticVersionId(d, i),
        note: d.note,
        date: d.date,
        links: d.links.map(l => ({ url: l.url, mediaType: l.media_type })),
      }))
      const providerData = JSON.stringify({
        versions: normalizedVersions,
        documents: normalizedDocuments,
        actions: bill.actions.map(a => ({
          description: a.description,
          date: a.date,
          chamber: a.organization__name.toLowerCase().includes('senate') ? 'upper' : 'lower',
          classification: a.classification,
          order: a.order,
        })),
        sponsors: bill.sponsors.map(s => ({ name: s.name, primary: s.primary, classification: s.classification })),
        votes: bill.votes ?? [],
        relatedBills: bill.related_bills ?? [],
      })

      statements.push(
        `INSERT INTO bills (bill_id, session_id, state, number, title, abstract, status, status_date, last_action, last_action_date, state_url, provider_data, created_at, updated_at) ` +
        `VALUES (${esc(bill.id)}, ${esc(resolvedSessionId)}, ${esc(state)}, ${esc(bill.identifier)}, ` +
        `${esc(bill.title)}, ${esc(abstract)}, ` +
        `${esc(lastAction?.classification[0] ?? null)}, ${esc(lastAction?.date ?? null)}, ` +
        `${esc(lastAction?.description ?? null)}, ${esc(lastAction?.date ?? null)}, ` +
        `${esc(bill.sources[0]?.url ?? null)}, ${esc(providerData)}, ${esc(now)}, ${esc(now)}) ` +
        `ON CONFLICT(bill_id) DO NOTHING;`,
      )

      if (tenantId) {
        const text = `${bill.title} ${abstract ?? ''}`
        const result = keywords.length > 0
          ? kwMatch(text, keywords)
          : { matched: true, keyword: '' }

        if (result.matched) {
          kwMatchCount++
          statements.push(
            `INSERT INTO bill_tenants (bill_id, tenant_id, matched_keyword) ` +
            `VALUES (${esc(bill.id)}, ${esc(tenantId)}, ${esc(result.keyword || null)}) ` +
            `ON CONFLICT(bill_id, tenant_id) DO NOTHING;`,
          )
          // Find best version link: prefer latest PDF, fall back to latest HTML, then raw_text
          const sortedVersions = [...bill.versions].sort((a, b) => b.date.localeCompare(a.date))
          let bestUrl: string | null = null
          let bestMediaType: string | null = null
          for (const v of sortedVersions) {
            const pdfLink = v.links.find(l => l.media_type === 'application/pdf' || l.media_type.includes('pdf'))
            if (pdfLink) { bestUrl = pdfLink.url; bestMediaType = 'application/pdf'; break }
          }
          if (!bestUrl) {
            for (const v of sortedVersions) {
              const htmlLink = v.links.find(l => l.media_type.includes('html') || l.media_type === 'text/html')
              if (htmlLink) { bestUrl = htmlLink.url; bestMediaType = htmlLink.media_type; break }
            }
          }
          if (bestUrl && bestMediaType) {
            textsToUpload.push({ billId: bill.id, url: bestUrl, mediaType: bestMediaType })
          } else if (bill.raw_text) {
            textsToUpload.push({ billId: bill.id, rawText: bill.raw_text })
          }
        }
      }
    }

    console.error(`  ${kwMatchCount} bills matched (bill_tenants rows), ${textsToUpload.length} have raw_text for R2 upload`)

    if (dryRun) {
      console.error('\n[DRY RUN] Would execute:')
      console.error(`  ${statements.length} SQL statements to central D1`)
      console.error(`  ${textsToUpload.length} R2 text uploads via ${CENTRAL_URL}`)
      if (tenantId) console.error(`  notify-unnotified for tenant ${tenantId}`)
      return
    }

    // Write to central D1
    console.error(`\nWriting ${statements.length} SQL statements to central D1...`)
    const tmpFile = join(tmpdir(), `seed-bulk-${state}-${Date.now()}.sql`)
    writeFileSync(tmpFile, statements.join('\n'))
    try {
      d1ExecuteFile(tmpFile)
      console.error('  Done: D1 writes complete')
    } finally {
      try { unlinkSync(tmpFile) } catch {}
    }

    // Upload texts to R2
    if (textsToUpload.length > 0) {
      console.error(`\nUploading ${textsToUpload.length} texts to central R2...`)
      let uploaded = 0
      const concurrency = 5
      let index = 0

      async function uploadOne(entry: typeof textsToUpload[number]): Promise<void> {
        const { billId } = entry
        let body: string | ArrayBuffer
        let contentType: string

        if ('url' in entry) {
          const dlRes = await fetch(entry.url)
          if (!dlRes.ok) {
            console.error(`  Warning: failed to download ${entry.url} for ${billId}: ${dlRes.status}`)
            return
          }
          const isPdf = entry.mediaType === 'application/pdf'
          body = isPdf ? await dlRes.arrayBuffer() : await dlRes.text()
          contentType = entry.mediaType
        } else {
          body = entry.rawText
          contentType = 'text/plain'
        }

        const res = await fetch(`${CENTRAL_URL}/admin/bills/${billId}/seed-text`, {
          method: 'PUT',
          body,
          headers: { 'x-admin-secret': ADMIN_SECRET, 'content-type': contentType },
        })
        if (!res.ok) {
          console.error(`  Warning: failed to upload text for ${billId}: ${res.status}`)
        } else {
          uploaded++
          if (uploaded % 25 === 0) console.error(`  ${uploaded}/${textsToUpload.length}...`)
        }
      }

      // Simple semaphore: process queue with max `concurrency` parallel fetches
      const queue = [...textsToUpload]
      async function worker(): Promise<void> {
        while (index < queue.length) {
          const entry = queue[index++]
          await uploadOne(entry)
        }
      }

      const workers: Promise<void>[] = []
      for (let i = 0; i < concurrency; i++) {
        workers.push(worker())
      }
      await Promise.all(workers)

      console.error(`  Done: ${uploaded}/${textsToUpload.length} texts uploaded`)
    }

    // Notify unnotified
    if (tenantId) {
      console.error(`\nCalling notify-unnotified for ${tenantId}...`)
      const res = await fetch(`${CENTRAL_URL}/admin/notify-unnotified/${tenantId}`, {
        method: 'POST',
        headers: { 'x-admin-secret': ADMIN_SECRET },
      })
      if (res.ok) {
        const body = await res.json() as { queued: number }
        console.error(`  Done: ${body.queued} bills queued to tenant`)
      } else {
        console.error(`  Warning: notify-unnotified returned ${res.status}`)
        console.error('\nRun manually:')
        console.error(`  curl -X POST ${CENTRAL_URL}/admin/notify-unnotified/${tenantId} \\`)
        console.error(`    -H "x-admin-secret: <ADMIN_SECRET>"`)
      }
    }

    console.error(`\nDone: ${bills.length} bills processed, ${kwMatchCount} matched, ${textsToUpload.length} texts uploaded`)
  } finally {
    if (tmpWorkDir) {
      try { execSync(`rm -rf ${JSON.stringify(tmpWorkDir)}`) } catch {}
    }
  }
}

main().catch(e => { console.error(e); process.exit(1) })
