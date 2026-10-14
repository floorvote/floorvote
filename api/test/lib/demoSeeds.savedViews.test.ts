import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { app } from '../../src/index'
import { resetDb, applyMigrations, seedBill, seedSession } from '../helpers'
import { getDb } from '../../src/db/client'
import { billSubjects } from '../../src/db/schema'
import { runDemoReset } from '../../src/lib/demoReset'
import { DEMO_SEEDS, type DemoSeed } from '../../src/lib/demoSeeds'
import { LM_BILLS } from '../../src/lib/demoSeeds/lakeMichigan/bills'

/**
 * The view switcher renders nothing for an instance with no saved views, so a
 * demo without them hides the feature. These tests run a real reset and then ask
 * the API the question a visitor's browser asks: which views exist, and what does
 * each one return?
 *
 * The fixtures below stand in for what ingest gives the demo's real bills. Tags
 * are AI-assigned and subjects are the legislature's, so neither lives in the
 * seed; each fixture states where its values came from.
 */
type BillFixture = { externalId: string; state: string; tags: string[]; subjects: string[] }

// The eight NJ bills are all elections bills. LegiScan files NJ election bills
// under "State and Local Government", not "Elections" (docs/internal/legiscan-api.md,
// "NJ-Specific Findings"). Tags: A548 is about clerk filings, the rest about elections.
const NJ_FIXTURES: BillFixture[] = [
  ['legiscan:2099974', 'Elections'],
  ['legiscan:2100182', 'Elections'],
  ['legiscan:2098535', 'Elections'],
  ['legiscan:2098113', 'Elections'],
  ['legiscan:2098630', 'Elections'],
  ['legiscan:2096183', 'Elections'],
  ['legiscan:2099056', 'Board of Elections'],
  ['legiscan:2096553', 'County Clerk Functions'],
].map(([externalId, tag]) => ({
  externalId, state: 'NJ', tags: [tag], subjects: ['State and Local Government'],
}))

// Each Lake Michigan bill carries the one taxonomy theme the seed assigns it. The
// seed records no subjects for these bills, so the fixtures give them none: a view
// has to match on its seed-owned facts or on a tag, never on a subject the seed
// cannot vouch for.
const LM_FIXTURES: BillFixture[] = LM_BILLS.map(b => ({
  externalId: b.externalId, state: b.jurisdiction, tags: [b.theme], subjects: [],
}))

const CASES: Array<{ slug: string; fixtures: BillFixture[] }> = [
  { slug: 'nj-county-clerks', fixtures: NJ_FIXTURES },
  { slug: 'lake-michigan', fixtures: LM_FIXTURES },
]

type ViewDto = { id: string; name: string; query: string; slug: string }

// A fresh session each call: a reset replaces the demo-user row, which takes the
// sessions this test minted with it.
async function demoUserCookie(): Promise<string> {
  return `session=${await seedSession('demo-user')}`
}

async function listViews(): Promise<ViewDto[]> {
  const res = await app.request('/api/views', { headers: { Cookie: await demoUserCookie() } }, env)
  expect(res.status).toBe(200)
  return ((await res.json()) as { views: ViewDto[] }).views
}

async function seedFixtures(seed: DemoSeed, fixtures: BillFixture[]) {
  const db = getDb(env.DB)
  for (const [i, f] of fixtures.entries()) {
    const id = await seedBill({
      externalId: f.externalId, billNumber: `B${1000 + i}`, title: `Bill ${i}`,
      state: f.state, tags: f.tags,
    })
    if (f.subjects.length > 0) {
      await db.insert(billSubjects).values(
        f.subjects.map(name => ({ billId: id, subjectName: name, state: f.state })),
      ).run()
    }
  }
  // Every bill the seed's own rows point at must exist, or the reset's guards
  // would no-op and the priority and position views would have nothing to match.
  expect(new Set(fixtures.map(f => f.externalId))).toEqual(new Set(seed.priorities.map(p => p.externalId)))
}

describe.each(CASES)('saved views in the $slug demo seed', ({ slug, fixtures }) => {
  const seed = DEMO_SEEDS[slug]

  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    await seedFixtures(seed, fixtures)
    await runDemoReset(env.DB, seed)
  })

  it('creates two or three views, each with a name and a filter', async () => {
    const views = await listViews()
    expect(views.length).toBeGreaterThanOrEqual(2)
    expect(views.length).toBeLessThanOrEqual(3)
    for (const v of views) {
      expect(v.name.trim().length).toBeGreaterThan(0)
      expect(v.query.trim().length).toBeGreaterThan(0)
    }
  })

  it('has a view that joins subjects and tags with the OR group operator', async () => {
    const views = await listViews()
    const orViews = views.filter(v => {
      const p = new URLSearchParams(v.query)
      return p.get('match') === 'any' && p.getAll('subject').length > 0 && p.getAll('tag').length > 0
    })
    expect(orViews.length).toBeGreaterThanOrEqual(1)
  })

  it('returns at least one bill from every view', async () => {
    const views = await listViews()
    expect(views.length).toBeGreaterThan(0)
    for (const v of views) {
      const res = await app.request(`/api/bills?${v.query}`, { headers: { Cookie: await demoUserCookie() } }, env)
      expect(res.status, v.name).toBe(200)
      const body = await res.json() as { pagination: { total: number } }
      expect(body.pagination.total, `${v.name} (${v.query})`).toBeGreaterThanOrEqual(1)
    }
  })

  it('restores the views on the next reset, whatever happened to them in between', async () => {
    const before = await listViews()
    expect(before.length).toBeGreaterThanOrEqual(2)

    // A view deleted, a view rewritten, and a view added by a visitor with admin rights.
    await env.DB.prepare('DELETE FROM saved_views WHERE id = ?').bind(before[0].id).run()
    await env.DB.prepare(`UPDATE saved_views SET query = 'q=nothing' WHERE id = ?`).bind(before[1].id).run()
    await env.DB.prepare(
      `INSERT INTO saved_views (id, name, query, slug, display_order) VALUES ('stray', 'Stray', 'q=x', 'stray', 99)`,
    ).run()

    await runDemoReset(env.DB, seed)
    expect(await listViews()).toEqual(before)
  })

  it('gives views stable ids and slugs across resets, so a bookmark survives', async () => {
    const first = await listViews()
    expect(first.length).toBeGreaterThanOrEqual(2)
    await runDemoReset(env.DB, seed)
    await runDemoReset(env.DB, seed)
    expect(await listViews()).toEqual(first)
  })
})
