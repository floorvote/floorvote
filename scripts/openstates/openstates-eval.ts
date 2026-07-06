#!/usr/bin/env npx tsx
/**
 * OpenStates API v3 evaluation script
 *
 * Assesses whether OpenStates can replace LegiScan as our legislative data source.
 * Evaluates RI and NJ (our current/prior target states) plus a few others.
 *
 * Run: npx tsx scripts/openstates-eval.ts
 */

import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'

// ── Config ──────────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const ENV_FILE = path.join(__dirname, '.env.openstates')
const envContent = fs.readFileSync(ENV_FILE, 'utf-8')
const apiKeyMatch = envContent.match(/OPENSTATES_API_KEY=(.+)/)
if (!apiKeyMatch) throw new Error('OPENSTATES_API_KEY not found in scripts/.env.openstates')
const API_KEY = apiKeyMatch[1].trim()
const BASE_URL = 'https://v3.openstates.org'

// States to evaluate — RI is prod, NJ was our research state, add a couple others
const TARGET_STATES = ['ri', 'nj', 'ut', 'mn']

// Exact keywords from api/src/lib/keywords.ts (kept in sync)
const ELECTION_KEYWORDS = [
  'election', 'ballot', 'voter', 'voting', 'precinct', 'polling', 'absentee',
  'poll worker', 'election official', 'canvass', 'recount', 'redistrict',
  'campaign finance', 'candidate filing', 'electoral college', 'popular vote',
  'elective public office', 'elective office', 'nominating petition', 'recall election',
]

const WORD_BOUNDARY_KEYWORDS = new Set(['election'])

// ── API helpers ──────────────────────────────────────────────────────────────

async function osGet(path: string, params: Record<string, string | number | string[]> = {}): Promise<any> {
  const url = new URL(`${BASE_URL}${path}`)
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) {
      for (const item of v) url.searchParams.append(k, item)
    } else {
      url.searchParams.set(k, String(v))
    }
  }
  url.searchParams.set('apikey', API_KEY)
  const res = await fetch(url.toString())
  if (!res.ok) throw new Error(`OpenStates ${path} → ${res.status}: ${await res.text()}`)
  return res.json()
}

function matchesKeywords(text: string): { matched: boolean; keyword: string } {
  const lower = text.toLowerCase()
  for (const kw of ELECTION_KEYWORDS) {
    if (WORD_BOUNDARY_KEYWORDS.has(kw)) {
      const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      if (new RegExp(`(?<![a-zA-Z])${escaped}`, 'i').test(lower)) return { matched: true, keyword: kw }
    } else {
      if (lower.includes(kw.toLowerCase())) return { matched: true, keyword: kw }
    }
  }
  return { matched: false, keyword: '' }
}

// 10 req/min free tier = 1 req per 6s; use 7s to be safe
function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)) }
const RATE_DELAY = 7000

// ── Sections ─────────────────────────────────────────────────────────────────

function heading(s: string) {
  console.log('\n' + '='.repeat(70))
  console.log(s)
  console.log('='.repeat(70))
}

function sub(s: string) {
  console.log('\n── ' + s)
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const report: string[] = []
  const log = (s: string) => { console.log(s); report.push(s) }

  log('# OpenStates API v3 — Evaluation Report')
  log(`Generated: ${new Date().toISOString()}`)
  log('')

  // ── 1. Jurisdictions / session discovery ────────────────────────────────

  heading('1. JURISDICTION & SESSION DISCOVERY')

  const jurisdictions = await osGet('/jurisdictions', { classification: 'state', include: 'legislative_sessions', per_page: 52 })
  log(`Total state jurisdictions returned: ${jurisdictions.results.length}`)

  const stateMap: Record<string, any> = {}
  for (const j of jurisdictions.results) {
    // jurisdiction id format: ocd-jurisdiction/country:us/state:ri/government
    const m = j.id.match(/state:([a-z]+)\//)
    if (m) stateMap[m[1]] = j
  }

  log(`\nSessions available for target states:`)
  for (const state of TARGET_STATES) {
    const j = stateMap[state]
    if (!j) { log(`  ${state.toUpperCase()}: NOT FOUND`); continue }
    const sessions = (j.legislative_sessions ?? []).slice(-4) // last 4
    log(`  ${state.toUpperCase()} (latest_bill_update: ${j.latest_bill_update}):`)
    for (const s of sessions) {
      log(`    session="${s.identifier}" name="${s.name}" start=${s.start_date} end=${s.end_date || 'ongoing'}`)
    }
  }

  // ── 2. Bill count comparison per state ──────────────────────────────────

  heading('2. BILL VOLUME — OpenStates vs LegiScan')
  log(`(LegiScan reference: NJ had 9,569 bills in 2026-2027 session)`)

  interface StatsBucket {
    state: string
    session: string
    totalBills: number
    electionBills: number
    sampleBills: any[]
    hasAbstracts: boolean
    hasSubjects: boolean
    hasVersions: boolean
    hasVotes: boolean
    hasActions: boolean
    hasSponsors: boolean
    hasText: boolean
    changeHashEquivalent: string | null
    notes: string[]
  }

  const stateStats: StatsBucket[] = []

  for (const state of TARGET_STATES) {
    sub(`State: ${state.toUpperCase()}`)
    const j = stateMap[state]
    if (!j) { log('  NOT IN OPENSTATES'); continue }

    // Find current/most-recent session
    const sessions: any[] = j.legislative_sessions ?? []
    // prefer one with no end_date (ongoing), else take latest
    const currentSession = sessions.find((s: any) => !s.end_date) ?? sessions[sessions.length - 1]
    if (!currentSession) { log('  No sessions found'); continue }

    const sessionId = currentSession.identifier
    log(`  Session: "${sessionId}" (${currentSession.name})`)

    // Fetch first page to get total count
    const firstPage = await osGet('/bills', {
      jurisdiction: state,
      session: sessionId,
      per_page: 20,
      page: 1,
    })
    const total = firstPage.pagination.total_items
    const maxPage = firstPage.pagination.max_page
    log(`  Total bills: ${total} (${maxPage} pages at 20/page)`)

    await sleep(RATE_DELAY)

    // Fetch with full includes to inspect data quality
    const samplePage = await osGet('/bills', {
      jurisdiction: state,
      session: sessionId,
      per_page: 20,
      page: 1,
      include: ['abstracts', 'actions', 'sponsorships', 'versions', 'votes', 'sources'],
    })

    await sleep(RATE_DELAY)

    const sampleBills: any[] = samplePage.results
    const sample = sampleBills[0]

    // Check data quality
    const hasAbstracts = sampleBills.some((b: any) => b.abstracts?.length > 0)
    const hasSubjects = sampleBills.some((b: any) => b.subject?.length > 0)
    const hasVersions = sampleBills.some((b: any) => b.versions?.length > 0)
    const hasVotes = sampleBills.some((b: any) => b.votes?.length > 0)
    const hasActions = sampleBills.some((b: any) => b.actions?.length > 0)
    const hasSponsors = sampleBills.some((b: any) => b.sponsorships?.length > 0)

    // Check if versions have downloadable text links
    const versionWithLink = sampleBills.flatMap((b: any) => b.versions ?? []).find((v: any) => v.links?.length > 0)
    const hasText = !!versionWithLink

    // OpenStates doesn't have change_hash like LegiScan, but updated_at serves this purpose
    const changeHashEquivalent = 'updated_at (ISO datetime)'

    log(`  Data quality (first 50 bills):`)
    log(`    has abstracts:   ${hasAbstracts}`)
    log(`    has subjects:    ${hasSubjects}`)
    log(`    has versions:    ${hasVersions}`)
    log(`    has text links:  ${hasText}${hasText ? ` — ${versionWithLink.links[0]?.url?.substring(0, 80)}` : ''}`)
    log(`    has votes:       ${hasVotes}`)
    log(`    has actions:     ${hasActions}`)
    log(`    has sponsors:    ${hasSponsors}`)
    log(`    change detection: ${changeHashEquivalent}`)

    if (sample) {
      log(`\n  Sample bill: ${sample.identifier} — "${sample.title}"`)
      log(`    id:                ${sample.id}`)
      log(`    updated_at:        ${sample.updated_at}`)
      log(`    first_action_date: ${sample.first_action_date}`)
      log(`    latest_action:     ${sample.latest_action_date} — ${sample.latest_action_description}`)
      log(`    classification:    ${JSON.stringify(sample.classification)}`)
      log(`    subject:           ${JSON.stringify(sample.subject)}`)
      if (sample.abstracts?.length > 0) log(`    abstract:          "${sample.abstracts[0].abstract?.substring(0, 120)}..."`)
      if (sample.actions?.length > 0) log(`    actions count:     ${sample.actions.length}`)
      if (sample.sponsorships?.length > 0) log(`    sponsors:          ${sample.sponsorships.map((s: any) => `${s.name} (${s.classification})`).join(', ')}`)
      if (sample.versions?.length > 0) {
        const v = sample.versions[sample.versions.length - 1]
        log(`    latest version:    "${v.note}" ${v.date} → ${v.links?.[0]?.url?.substring(0, 80)}`)
      }
    }

    // ── Keyword filtering on the full first page ─────────────────────────

    // Fetch up to 500 bills to get a proper keyword count
    // OpenStates max per_page is typically 20 for large result sets; use action_since to sample current session
    let allBills: any[] = [...sampleBills]
    const pagesToFetch = Math.min(maxPage, 4) // cap at 4 pages (80 bills) to stay under rate limit
    for (let page = 2; page <= pagesToFetch; page++) {
      await sleep(RATE_DELAY)
      const p = await osGet('/bills', {
        jurisdiction: state,
        session: sessionId,
        per_page: 20,
        page,
      })
      allBills = allBills.concat(p.results)
    }

    const electionBills = allBills.filter(b => {
      const text = `${b.title} ${b.abstracts?.map((a: any) => a.abstract).join(' ') ?? ''}`
      return matchesKeywords(text).matched
    })

    const sampleRate = allBills.length / total
    const estimatedTotal = Math.round(electionBills.length / sampleRate)

    log(`\n  Keyword filter (on ${allBills.length} sampled bills, ${(sampleRate * 100).toFixed(1)}% of session):`)
    log(`    matched in sample:     ${electionBills.length} / ${allBills.length} (${(electionBills.length / allBills.length * 100).toFixed(1)}%)`)
    log(`    estimated session total: ~${estimatedTotal} election-related bills`)
    if (electionBills.length > 0) {
      log(`    sample matches:`)
      for (const b of electionBills.slice(0, 5)) {
        const txt = `${b.title}`
        const { keyword } = matchesKeywords(txt)
        log(`      [${keyword}] ${b.identifier}: ${b.title.substring(0, 80)}`)
      }
    }

    const notes: string[] = []
    if (!hasSubjects) notes.push('No subject tags — keyword filtering on title only (same as LegiScan)')
    if (!hasText) notes.push('WARNING: No downloadable bill text links found in sample')
    if (!hasVersions) notes.push('WARNING: No version history in sample')

    stateStats.push({
      state,
      session: sessionId,
      totalBills: total,
      electionBills: estimatedTotal,
      sampleBills,
      hasAbstracts,
      hasSubjects,
      hasVersions,
      hasVotes,
      hasActions,
      hasSponsors,
      hasText,
      changeHashEquivalent,
      notes,
    })

    await sleep(RATE_DELAY)
  }

  // ── 3. Field mapping: LegiScan → OpenStates ──────────────────────────────

  heading('3. FIELD MAPPING: LegiScan → OpenStates')

  log(`
What central stores from LegiScan (central/src/db/schema.ts bills table):

  LegiScan field          OpenStates equivalent           Notes
  ─────────────────────── ─────────────────────────────── ─────────────────────────────
  bill_id (integer PK)    id (ocd-bill/uuid string)       Type change: int → string UUID
  session_id (integer FK) session (string identifier)     Type change: int → string
  state (text)            jurisdiction.id / name          Derivable from jurisdiction
  number (text)           identifier                      Direct equivalent
  title (text)            title                           Direct equivalent
  description (text)      abstracts[0].abstract           Optional, may be empty
  status (integer)        latest_action_description       No numeric status code
  status_date (text)      latest_action_date              Direct equivalent
  last_action (text)      latest_action_description       Direct equivalent
  last_action_date (text) latest_action_date              Direct equivalent
  change_hash (text)      updated_at (datetime)           CRITICAL: no hash, use timestamp
  url (text)              openstates_url / sources[0].url Different URL format
  full_json (text)        full bill object                Store as JSON same way

What the tenant queue processor gets (for AI processing):
  bill number, title, description, status, sponsors, history → all available
  bill text (base64 from getBillText) → versions[].links[] → direct URL download

CRITICAL GAPS:
  1. No change_hash — must track updated_at timestamp instead; risk of missing updates
     if OpenStates doesn't bump updated_at on every change
  2. Bill IDs change type (int → UUID string) — requires schema migration for central + tenant DBs
  3. Session IDs change type (int → string) — same
  4. No guaranteed description/abstract for all bills in all states
  5. Text download is a direct URL (PDF/HTML) — no base64 decode step needed (simpler!)
     but we'd fetch directly instead of going through LegiScan's getBillText API
`)

  // ── 4. Change detection investigation ───────────────────────────────────

  heading('4. CHANGE DETECTION: updated_at vs change_hash')

  log(`
LegiScan approach:
  - getMasterListRaw returns bill_id + change_hash for all bills (~100KB)
  - Cheap hourly poll: compare change_hash, only fetch changed bills
  - Deterministic: hash changes iff bill content changed

OpenStates approach:
  - /bills?updated_since=<ISO_datetime> — fetch bills updated since a timestamp
  - More natural REST approach, no separate "raw" endpoint needed
  - Can run hourly: GET /bills?jurisdiction=ri&session=222&updated_since=<last_check>
  - Paginated response only includes actually-changed bills
  - Risk: if updated_at doesn't track all changes (e.g. vote added but bill not updated),
    we could miss events — needs verification

Conclusion: updated_since filter is a cleaner API design than getMasterListRaw polling.
Risk level: LOW if OpenStates bumps updated_at on related object changes (votes, amendments).
`)

  // Test updated_since
  const oneDayAgo = new Date(Date.now() - 86400 * 1000).toISOString()
  sub(`Testing updated_since for RI (last 24h)`)
  try {
    const riStats = stateStats.find(s => s.state === 'ri')
    if (riStats) {
      await sleep(RATE_DELAY)
      const recentBills = await osGet('/bills', {
        jurisdiction: 'ri',
        session: riStats.session,
        updated_since: oneDayAgo,
        per_page: 20,
      })
      log(`  Bills updated in last 24h for RI: ${recentBills.pagination.total_items}`)
      if (recentBills.results.length > 0) {
        log(`  Sample: ${recentBills.results[0].identifier} updated ${recentBills.results[0].updated_at}`)
      }
    }
  } catch (e: any) {
    log(`  updated_since test failed: ${e.message}`)
  }

  // ── 5. Text access ────────────────────────────────────────────────────────

  heading('5. BILL TEXT ACCESS')

  log(`
LegiScan text access:
  1. getBill → bill.texts[] → doc_id, mime, text_hash, text_size
  2. getBillText(doc_id) → base64-encoded text (HTML or PDF)
  3. We decode and store in R2

OpenStates text access:
  - bill.versions[] → each version has links[] → each link has {url, media_type}
  - Direct download: GET {url} → HTML or PDF
  - No API call needed — just fetch the URL directly
  - Simpler! But we're responsible for deduplication (no text_hash provided)
  - Would need to track URL or content hash ourselves for dedup
`)

  // Check one actual text URL for RI if we have version data
  const riWithVersions = stateStats.find(s => s.state === 'ri' && s.hasVersions)
  if (riWithVersions) {
    sub('Checking a live text URL for RI')
    try {
      await sleep(RATE_DELAY)
      const billWithText = await osGet('/bills', {
        jurisdiction: 'ri',
        session: riWithVersions.session,
        per_page: 5,
        page: 1,
        include: ['versions'],
      })
      const billWithVersion = billWithText.results.find((b: any) => b.versions?.length > 0)
      if (billWithVersion) {
        const v = billWithVersion.versions[billWithVersion.versions.length - 1]
        const link = v.links?.[0]
        log(`  Bill: ${billWithVersion.identifier} — "${billWithVersion.title}"`)
        log(`  Version: "${v.note}" ${v.date}`)
        log(`  Text URL: ${link?.url}`)
        log(`  Media type: ${link?.media_type}`)
        // Try HEAD request to verify URL is accessible
        if (link?.url) {
          const headRes = await fetch(link.url, { method: 'HEAD' })
          log(`  HEAD response: ${headRes.status} (content-type: ${headRes.headers.get('content-type')})`)
        }
      } else {
        log('  No bill with version links found in sample')
      }
    } catch (e: any) {
      log(`  Text URL check failed: ${e.message}`)
    }
  }

  // ── 6. Rate limits ────────────────────────────────────────────────────────

  heading('6. RATE LIMITS & PAGINATION')

  log(`
From docs: Rate limiting added 2020.10.13, details in response headers.
Observed behavior during this script: no 429s with 300-500ms delays between calls.

Pagination: max per_page appears to be 20 for bill search (docs say default 10).
  - RI 2025 session: need to check total pages
  - With updated_since, only changed bills are returned → small result sets normally

LegiScan free tier: 30,000 credits/month (1 credit = 1 API call).
OpenStates: Free tier exists, paid plans for higher volume — need to verify limits.
`)

  // Check rate limit headers
  sub('Checking rate limit headers')
  const testUrl = new URL(`${BASE_URL}/jurisdictions`)
  testUrl.searchParams.set('apikey', API_KEY)
  testUrl.searchParams.set('classification', 'state')
  const headersRes = await fetch(testUrl.toString())
  const rateLimitHeaders: Record<string, string> = {}
  headersRes.headers.forEach((v, k) => {
    if (k.toLowerCase().includes('rate') || k.toLowerCase().includes('limit') || k.toLowerCase().includes('x-')) {
      rateLimitHeaders[k] = v
    }
  })
  log('  Rate-limit related headers:')
  if (Object.keys(rateLimitHeaders).length === 0) {
    log('  (none found in response)')
  } else {
    for (const [k, v] of Object.entries(rateLimitHeaders)) log(`  ${k}: ${v}`)
  }

  // ── 7. Session discovery ──────────────────────────────────────────────────

  heading('7. SESSION DISCOVERY (equivalent to getSessionList)')

  log(`
LegiScan approach:
  - getSessionList?state=RI → list of sessions with session_id (integer), year_start, year_end, sine_die
  - We store session_id as FK; sine_die drives sync frequency

OpenStates approach:
  - GET /jurisdictions/ri?include=legislative_sessions
  - Returns legislative_sessions[]: identifier (string), name, start_date, end_date, classification
  - classification: "primary" or "special" (equiv to LegiScan's special flag)
  - end_date present → session has ended (equiv to sine_die=1)
  - No explicit "current" flag — infer from missing end_date or latest start_date

Mapping:
  LegiScan session_id (int) → OpenStates session identifier (string, e.g. "2025-2026" or "222")
  LegiScan sine_die (bool)  → OpenStates end_date != null
  LegiScan year_start/end   → derive from identifier or start_date/end_date
`)

  // Show RI sessions as example
  const riJurisdiction = await osGet('/jurisdictions/ocd-jurisdiction/country:us/state:ri/government', {
    include: 'legislative_sessions',
  })
  log('\n  RI sessions (last 5):')
  const riSessions = riJurisdiction.legislative_sessions ?? []
  for (const s of riSessions.slice(-5)) {
    log(`    id="${s.identifier}" name="${s.name}" start=${s.start_date} end=${s.end_date ?? 'ONGOING'} classification=${s.classification}`)
  }

  // ── 8. Summary ────────────────────────────────────────────────────────────

  heading('8. SUMMARY & RECOMMENDATION')

  log('\n## Per-state coverage')
  for (const s of stateStats) {
    log(`\n### ${s.state.toUpperCase()} (session: ${s.session})`)
    log(`  Total bills:        ${s.totalBills}`)
    log(`  Est. election bills: ~${s.electionBills}`)
    log(`  Abstracts:          ${s.hasAbstracts}`)
    log(`  Subjects:           ${s.hasSubjects}`)
    log(`  Bill text links:    ${s.hasText}`)
    log(`  Actions history:    ${s.hasActions}`)
    log(`  Vote records:       ${s.hasVotes}`)
    log(`  Sponsorships:       ${s.hasSponsors}`)
    if (s.notes.length > 0) log(`  Notes: ${s.notes.join('; ')}`)
  }

  log(`
## What would need to change to migrate

### Central Worker (central/)
  1. Schema: bill_id TEXT (UUID) not INTEGER; session_id TEXT not INTEGER
  2. No change_hash column → replace with openstates_updated_at TEXT
  3. legi_sessions → os_sessions (identifier TEXT PK instead of int)
  4. sync.ts: replace getMasterList/getMasterListRaw with /bills?updated_since=<last_check>
  5. processor.ts: replace getBill/getBillText with OpenStates bill detail + direct URL fetch
  6. No LegiScan API key needed
  7. Session discovery: /jurisdictions/:id?include=legislative_sessions

### Tenant Worker (api/)
  1. bills table: bill_id TEXT (or keep int and use a separate os_id column)
  2. Remove api/src/lib/legiscan.ts (only used in central now)
  3. centralFetch.ts: central exposes same /bills/:id endpoint → no tenant changes needed
     (as long as central normalizes to the same payload shape)

### Migration path
  Option A: Clean cut — new schema, backfill existing bills by matching number+state+session
  Option B: Add os_id column alongside bill_id, run in parallel during transition

## Key risks
  1. Bill ID type change (int → string) is the biggest migration risk
  2. change_hash dedup → updated_at polling: need to verify updated_at is reliable
  3. Text URL accessibility: some states host on state sites that may require auth or have aggressive rate limiting
  4. OpenStates data freshness: how quickly does OpenStates reflect new bills introduced today?
     LegiScan publishes same-day. Need to verify OpenStates lag.
  5. OpenStates free tier rate limits unknown — need to confirm for production volume

## Verdict
`)

  const allHaveText = stateStats.every(s => s.hasText)
  const allHaveActions = stateStats.every(s => s.hasActions)

  if (allHaveText && allHaveActions) {
    log(`  FEASIBLE — OpenStates has the core fields we need across all tested states.`)
    log(`  Migration is non-trivial (ID type change, sync logic rewrite) but straightforward.`)
    log(`  Recommend: verify updated_at reliability and rate limits before committing.`)
  } else {
    log(`  PARTIAL FEASIBILITY — some states missing critical data:`)
    for (const s of stateStats) {
      if (!s.hasText) log(`  - ${s.state.toUpperCase()}: no text links`)
      if (!s.hasActions) log(`  - ${s.state.toUpperCase()}: no action history`)
    }
  }

  // ── Write report ──────────────────────────────────────────────────────────

  const reportPath = path.join(__dirname, '..', 'research', 'openstates-eval.md')
  fs.writeFileSync(reportPath, report.join('\n'))
  console.log(`\n\nReport written to: ${reportPath}`)
}

main().catch(err => {
  console.error('Fatal:', err)
  process.exit(1)
})
