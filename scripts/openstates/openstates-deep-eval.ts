#!/usr/bin/env npx tsx
/**
 * Deep OpenStates evaluation — cross-reference staging instance bills
 * with OpenStates bulk JSON downloads.
 *
 * Run: npx tsx scripts/openstates-deep-eval.ts
 */

import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// ── Config ──────────────────────────────────────────────────────────────────

const envContent = fs.readFileSync(path.join(__dirname, '.env.openstates'), 'utf-8')
const API_KEY = envContent.match(/OPENSTATES_API_KEY=(.+)/)?.[1]?.trim()!

const centralDevVars = fs.readFileSync(path.join(__dirname, '..', 'central', '.dev.vars'), 'utf-8')
const ADMIN_SECRET = centralDevVars.match(/ADMIN_SECRET=(.+)/)?.[1]?.trim()!

const CENTRAL_URL = process.env.CENTRAL_URL ?? 'http://localhost:8787'
const OS_BASE = 'https://v3.openstates.org'

// Election officials preset keywords (same as api/src/lib/keywords.ts)
const ELECTION_KEYWORDS = [
  'election', 'ballot', 'voter', 'voting', 'precinct', 'polling', 'absentee',
  'poll worker', 'election official', 'canvass', 'recount', 'redistrict',
  'campaign finance', 'candidate filing', 'electoral college', 'popular vote',
  'elective public office', 'elective office', 'nominating petition', 'recall election',
]

const WORD_BOUNDARY_KEYWORDS = new Set(['election'])

// ── Helpers ──────────────────────────────────────────────────────────────────

function matchesKeywords(text: string, keywords: string[]): { matched: boolean; keyword: string } {
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

async function centralGet(path: string): Promise<any> {
  const res = await fetch(`${CENTRAL_URL}${path}`, {
    headers: { 'x-admin-secret': ADMIN_SECRET },
  })
  if (!res.ok) throw new Error(`Central ${path} → ${res.status}: ${await res.text()}`)
  return res.json()
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)) }

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const log = (s: string) => console.log(s)

  log('# OpenStates Deep Evaluation — Cross-Reference with Central')
  log(`Generated: ${new Date().toISOString()}\n`)

  // ── 1. Get bills from central ──────────────────────────────────────────

  log('## 1. Fetching bills from central D1')

  let centralBills: any[]
  try {
    const stats = await centralGet('/stats')
    log(`Central stats: ${JSON.stringify(stats)}`)
  } catch (e: any) {
    log(`Stats failed: ${e.message}`)
  }

  // Get tenants
  let centralTenants: any[]
  try {
    centralTenants = (await centralGet('/admin/tenants')).tenants ?? []
    log(`\nTenants registered:`)
    for (const t of centralTenants) {
      log(`  ${t.tenantId}: coverage=${t.stateCoverage}, active=${t.active}`)
    }
  } catch (e: any) {
    log(`Tenants fetch failed: ${e.message}`)
    centralTenants = []
  }

  // Get keywords from central
  let centralKeywords: any[]
  try {
    const kwData = await centralGet('/admin/keywords')
    centralKeywords = kwData.keywords ?? []
    const byTenant = new Map<string, string[]>()
    for (const kw of centralKeywords) {
      if (!byTenant.has(kw.tenantId)) byTenant.set(kw.tenantId, [])
      byTenant.get(kw.tenantId)!.push(kw.keyword)
    }
    log(`\nKeywords by tenant:`)
    for (const [tid, kws] of byTenant) {
      log(`  ${tid}: ${kws.length} keywords`)
      log(`    ${kws.join(', ')}`)
    }
  } catch (e: any) {
    log(`Keywords fetch failed: ${e.message}`)
    centralKeywords = []
  }

  // Get sessions from central
  let centralSessions: any[]
  try {
    centralSessions = (await centralGet('/admin/sessions')).sessions ?? []
    log(`\nSessions in central:`)
    for (const s of centralSessions) {
      log(`  ${s.state} session ${s.sessionId}: "${s.sessionName}" (${s.yearStart}-${s.yearEnd}) sine_die=${s.sineDie} last_synced=${s.lastSyncedAt}`)
    }
  } catch (e: any) {
    log(`Sessions fetch failed: ${e.message}`)
    centralSessions = []
  }

  // Get all bills from central
  try {
    const billData = await centralGet('/admin/bills')
    centralBills = billData.bills ?? []
    log(`\nTotal bills in central: ${centralBills.length}`)

    // Group by state
    const byState = new Map<string, any[]>()
    for (const b of centralBills) {
      if (!byState.has(b.state)) byState.set(b.state, [])
      byState.get(b.state)!.push(b)
    }
    for (const [state, bills] of byState) {
      log(`  ${state}: ${bills.length} bills`)
      // Group by session within state
      const bySess = new Map<number, any[]>()
      for (const b of bills) {
        if (!bySess.has(b.sessionId)) bySess.set(b.sessionId, [])
        bySess.get(b.sessionId)!.push(b)
      }
      for (const [sid, sbills] of bySess) {
        log(`    session ${sid}: ${sbills.length} bills`)
        log(`      samples: ${sbills.slice(0, 5).map((b: any) => b.number).join(', ')}`)
      }
    }
  } catch (e: any) {
    log(`Bills fetch failed: ${e.message}`)
    centralBills = []
  }

  // ── 2. Download OpenStates bulk JSONs for NJ, WI, WY ──────────────────

  log('\n\n## 2. OpenStates Bulk JSON Downloads')

  // First get jurisdiction info to find download URLs
  const states = ['nj', 'wi', 'wy']

  for (const state of states) {
    log(`\n### ${state.toUpperCase()}`)
    try {
      await sleep(7000)
      const jUrl = `${OS_BASE}/jurisdictions/ocd-jurisdiction/country:us/state:${state}/government?include=legislative_sessions&apikey=${API_KEY}`
      const jRes = await fetch(jUrl)
      if (!jRes.ok) throw new Error(`${jRes.status}: ${await jRes.text()}`)
      const jurisdiction = await jRes.json()

      const sessions = jurisdiction.legislative_sessions ?? []
      // Find sessions that overlap with what central tracks
      const recentSessions = sessions.filter((s: any) => {
        const year = parseInt(s.start_date?.substring(0, 4) ?? '0')
        return year >= 2024
      })

      log(`Recent sessions (2024+):`)
      for (const s of recentSessions) {
        log(`  id="${s.identifier}" name="${s.name}" start=${s.start_date} end=${s.end_date ?? 'ONGOING'}`)
        if (s.downloads?.length > 0) {
          for (const d of s.downloads) {
            log(`    download: ${d.data_type} → ${d.url}`)
            log(`    updated: ${d.updated_at}`)
          }
        } else {
          log(`    NO DOWNLOADS AVAILABLE`)
        }
      }
    } catch (e: any) {
      log(`  Failed: ${e.message}`)
    }
  }

  // ── 3. Download and analyze available JSONs ────────────────────────────

  log('\n\n## 3. Cross-Reference Analysis')

  // Download JSON bulk files for available states
  const downloadDir = '/tmp/openstates-eval'
  fs.mkdirSync(downloadDir, { recursive: true })

  for (const state of states) {
    log(`\n### ${state.toUpperCase()} — Downloading bulk data`)
    try {
      await sleep(7000)
      const jUrl = `${OS_BASE}/jurisdictions/ocd-jurisdiction/country:us/state:${state}/government?include=legislative_sessions&apikey=${API_KEY}`
      const jRes = await fetch(jUrl)
      const jurisdiction = await jRes.json()

      const sessions = jurisdiction.legislative_sessions ?? []
      const recentSessions = sessions.filter((s: any) => {
        const year = parseInt(s.start_date?.substring(0, 4) ?? '0')
        return year >= 2024
      })

      for (const session of recentSessions) {
        const jsonDownload = session.downloads?.find((d: any) => d.data_type === 'json')
        const csvDownload = session.downloads?.find((d: any) => d.data_type === 'csv')
        const download = jsonDownload ?? csvDownload

        if (!download) {
          log(`  ${session.identifier}: no download available`)
          continue
        }

        const zipPath = `${downloadDir}/${state}_${session.identifier}.zip`
        if (!fs.existsSync(zipPath)) {
          log(`  Downloading ${state} ${session.identifier} (${download.data_type})...`)
          const dlRes = await fetch(download.url)
          if (!dlRes.ok) {
            log(`  Download failed: ${dlRes.status}`)
            continue
          }
          const buf = Buffer.from(await dlRes.arrayBuffer())
          fs.writeFileSync(zipPath, buf)
          log(`  Saved: ${zipPath} (${(buf.length / 1024).toFixed(0)}KB)`)
        } else {
          log(`  Already downloaded: ${zipPath}`)
        }

        // Extract
        const extractDir = `${downloadDir}/${state}_${session.identifier}`
        const { execSync } = await import('child_process')
        execSync(`unzip -o "${zipPath}" -d "${extractDir}" > /dev/null 2>&1`, { stdio: 'pipe' })

        // Find bills JSON
        const billsJsonPath = execSync(`find "${extractDir}" -name "*bills.json" -type f`, { encoding: 'utf-8' }).trim()
        if (!billsJsonPath) {
          log(`  No bills.json found in ${extractDir}`)
          continue
        }

        const osBills = JSON.parse(fs.readFileSync(billsJsonPath, 'utf-8'))
        log(`  ${session.identifier}: ${osBills.length} total bills`)

        // Run keyword filter
        const matchedBills = osBills.filter((b: any) => {
          const abstractText = (b.abstracts ?? []).map((a: any) => a.abstract ?? '').join(' ')
          const text = `${b.title} ${abstractText}`
          return matchesKeywords(text, ELECTION_KEYWORDS).matched
        })

        log(`  Keyword matches: ${matchedBills.length} / ${osBills.length} (${(matchedBills.length / osBills.length * 100).toFixed(1)}%)`)

        // If we have central bills for this state, cross-reference
        if (centralBills.length > 0) {
          const centralForState = centralBills.filter((b: any) => b.state === state.toUpperCase())
          if (centralForState.length > 0) {
            log(`  Central has ${centralForState.length} bills for ${state.toUpperCase()}`)

            // Match by bill number
            const centralNumbers = new Set(centralForState.map((b: any) => b.number))
            const osNumbers = new Set(matchedBills.map((b: any) => b.identifier))

            const inBoth = [...centralNumbers].filter(n => osNumbers.has(n))
            const onlyCentral = [...centralNumbers].filter(n => !osNumbers.has(n))
            const onlyOS = [...osNumbers].filter(n => !centralNumbers.has(n))

            log(`  Cross-reference:`)
            log(`    In both:        ${inBoth.length}`)
            log(`    Only in central: ${onlyCentral.length}`)
            log(`    Only in OS:     ${onlyOS.length}`)

            if (onlyCentral.length > 0) {
              log(`  Bills in central but missing from OS keyword matches:`)
              for (const n of onlyCentral.slice(0, 20)) {
                // Check if the bill exists in OS at all
                const osBill = osBills.find((b: any) => b.identifier === n)
                if (osBill) {
                  const abstractText = (osBill.abstracts ?? []).map((a: any) => a.abstract ?? '').join(' ')
                  log(`    ${n}: exists in OS but didn't match keywords — "${osBill.title.substring(0, 60)}"`)
                } else {
                  log(`    ${n}: NOT FOUND in OpenStates at all`)
                }
              }
            }
            if (onlyOS.length > 0 && onlyOS.length < 20) {
              log(`  Bills in OS keyword matches but not in central:`)
              for (const n of onlyOS.slice(0, 10)) {
                const osBill = matchedBills.find((b: any) => b.identifier === n)
                log(`    ${n}: "${osBill?.title?.substring(0, 60)}"`)
              }
            }
          }
        }

        // Check data quality
        const withAbstracts = osBills.filter((b: any) => (b.abstracts?.length ?? 0) > 0).length
        const withRawText = osBills.filter((b: any) => b.raw_text?.length > 0).length
        const withVotes = osBills.filter((b: any) => (b.votes?.length ?? 0) > 0).length
        const withActions = osBills.filter((b: any) => (b.actions?.length ?? 0) > 0).length
        const withSponsors = osBills.filter((b: any) => (b.sponsors?.length ?? 0) > 0).length

        log(`  Data quality:`)
        log(`    abstracts:  ${withAbstracts} / ${osBills.length} (${(withAbstracts/osBills.length*100).toFixed(0)}%)`)
        log(`    raw_text:   ${withRawText} / ${osBills.length} (${(withRawText/osBills.length*100).toFixed(0)}%)`)
        log(`    votes:      ${withVotes} / ${osBills.length} (${(withVotes/osBills.length*100).toFixed(0)}%)`)
        log(`    actions:    ${withActions} / ${osBills.length} (${(withActions/osBills.length*100).toFixed(0)}%)`)
        log(`    sponsors:   ${withSponsors} / ${osBills.length} (${(withSponsors/osBills.length*100).toFixed(0)}%)`)
      }
    } catch (e: any) {
      log(`  Failed: ${e.message}`)
    }
  }

  log('\n\nDone.')
}

main().catch(err => {
  console.error('Fatal:', err)
  process.exit(1)
})
