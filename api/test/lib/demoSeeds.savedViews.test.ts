import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { app } from '../../src/index'
import { resetDb, applyMigrations, seedBill, seedSession } from '../helpers'
import { runDemoReset } from '../../src/lib/demoReset'
import { DEMO_SEEDS, type DemoSeed } from '../../src/lib/demoSeeds'
import { LM_BILLS } from '../../src/lib/demoSeeds/lakeMichigan/bills'

/**
 * The view switcher renders nothing for an instance with no saved views, so a
 * demo without them hides the feature. These tests run a real reset and then ask
 * the API the question a visitor's browser asks: which views exist, and what does
 * each one return?
 *
 * The fixtures stand in for what ingest gives the demo's real bills: the state and
 * the AI-assigned tags. Everything else a view filters on (priority, position,
 * custom fields) is written by the reset itself, so those halves are exercised on
 * the seed's own data. No view uses a subject: the live NJ demo hides subjects
 * for the whole tenant, and the seed writes none of its own.
 */
type BillFixture = { externalId: string; state: string; tags: string[] }

// The eight NJ bills. Tags: A2670 is about county boards canvassing, A548 about
// clerk filings, the rest about elections.
const NJ_FIXTURES: BillFixture[] = [
  ['legiscan:2099974', 'Elections'],
  ['legiscan:2100182', 'Elections'],
  ['legiscan:2098535', 'Elections'],
  ['legiscan:2098113', 'Elections'],
  ['legiscan:2098630', 'Elections'],
  ['legiscan:2096183', 'Elections'],
  ['legiscan:2099056', 'Board of Elections'],
  ['legiscan:2096553', 'County Clerk Functions'],
].map(([externalId, tag]) => ({ externalId, state: 'NJ', tags: [tag] }))

// Each Lake Michigan bill carries the one taxonomy theme the seed assigns it.
const LM_FIXTURES: BillFixture[] = LM_BILLS.map(b => ({
  externalId: b.externalId, state: b.jurisdiction, tags: [b.theme],
}))

const CASES: Array<{ slug: string; fixtures: BillFixture[]; expectedTotals: Record<string, number> }> = [
  {
    slug: 'nj-county-clerks', fixtures: NJ_FIXTURES,
    expectedTotals: { 'high-priority-or-clerk-duties': 5, 'costly-bills-we-support': 3, 'positions-still-in-play': 2 },
  },
  {
    slug: 'lake-michigan', fixtures: LM_FIXTURES,
    expectedTotals: {
      'drinking-water-or-contaminants': 8, 'infrastructure-bills-with-no-position': 3,
      'high-priority-in-michigan-and-wisconsin': 5,
    },
  },
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

async function totalFor(query: string): Promise<number> {
  const res = await app.request(`/api/bills?${query}`, { headers: { Cookie: await demoUserCookie() } }, env)
  expect(res.status, query).toBe(200)
  return ((await res.json()) as { pagination: { total: number } }).pagination.total
}


/** An OR view, split into one query per filter dimension. Null for any view that is
 *  not `match=any` across at least two dimensions: `match=any` over a single
 *  dimension changes nothing, since a dimension's own values are always OR'd. */
function orDimensions(query: string): Array<{ key: string; query: string }> | null {
  const p = new URLSearchParams(query)
  if (p.get('match') !== 'any') return null
  const byKey = new Map<string, string[]>()
  for (const [k, v] of p) {
    if (k === 'match') continue
    const d = k
    byKey.set(d, [...(byKey.get(d) ?? []), v])
  }
  if (byKey.size < 2) return null
  return [...byKey].map(([key, values]) => ({
    key, query: new URLSearchParams(values.map((v): [string, string] => [key, v])).toString(),
  }))
}

async function seedFixtures(seed: DemoSeed, fixtures: BillFixture[]) {
  for (const [i, f] of fixtures.entries()) {
    await seedBill({
      externalId: f.externalId, billNumber: `B${1000 + i}`, title: `Bill ${i}`,
      state: f.state, tags: f.tags,
    })
  }
  // Every bill the seed's own rows point at must exist, or the reset's guards
  // would no-op and the priority, position, and custom-field views would have
  // nothing to match.
  expect(new Set(fixtures.map(f => f.externalId))).toEqual(new Set(seed.priorities.map(p => p.externalId)))
}

describe.each(CASES)('saved views in the $slug demo seed', ({ slug, fixtures, expectedTotals }) => {
  const seed = DEMO_SEEDS[slug]

  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    await seedFixtures(seed, fixtures)
    await runDemoReset(env.DB, seed)
  })

  it('creates exactly three views, each with a name and a filter', async () => {
    const views = await listViews()
    expect(views).toHaveLength(3)
    for (const v of views) {
      expect(v.name.trim().length).toBeGreaterThan(0)
      expect(v.query.trim().length).toBeGreaterThan(0)
    }
  })

  it('has at most one OR view, and combines several filters in the others', async () => {
    const views = await listViews()
    const or = views.filter(v => orDimensions(v.query) !== null)
    expect(or).toHaveLength(1)
    // A view that is one subject or one tag shows nothing of what a view is for.
    for (const v of views.filter(v => orDimensions(v.query) === null)) {
      const dims = new Set([...new URLSearchParams(v.query).keys()])
      expect(dims.size, `${v.name} (${v.query}) filters on one dimension`).toBeGreaterThanOrEqual(2)
    }
  })

  // The live demo hides subjects (NJ for the whole tenant), and the seed writes none,
  // so a subject filter would match nothing a visitor can see.
  it('uses no subject filter in any view', async () => {
    for (const v of await listViews()) {
      expect([...new URLSearchParams(v.query).keys()], `${v.name} (${v.query})`).not.toContain('subject')
    }
  })

  it('writes no subjects of its own', async () => {
    const stored = await env.DB.prepare('SELECT count(*) AS n FROM bill_subjects').first<{ n: number }>()
    expect(stored!.n).toBe(0)
  })

  // The OR operator hides which half carried a result, so each dimension is asked alone.
  it('returns bills from every dimension of the OR view, each on its own', async () => {
    const orViews = (await listViews()).filter(v => orDimensions(v.query) !== null)
    expect(orViews.length).toBeGreaterThanOrEqual(1)
    for (const v of orViews) {
      for (const { key, query } of orDimensions(v.query)!) {
        expect(await totalFor(query), `${v.name}: ${key} alone (${query})`).toBeGreaterThanOrEqual(1)
      }
    }
  })

  it('returns a non-empty subset of the demo\'s bills from every view', async () => {
    const views = await listViews()
    expect(views.length).toBeGreaterThan(0)
    for (const v of views) {
      const total = await totalFor(v.query)
      expect(total, `${v.name} (${v.query})`).toBeGreaterThanOrEqual(1)
      expect(total, `${v.name} returns every bill`).toBeLessThan(fixtures.length)
    }
  })

  // The counts the seed's comments promise, so a changed priority, position, or
  // custom-field value that quietly empties or floods a view fails here by name.
  it('returns the number of bills the seed says each view does', async () => {
    const got = Object.fromEntries(await Promise.all(
      (await listViews()).map(async v => [v.slug, await totalFor(v.query)] as const),
    ))
    expect(got).toEqual(expectedTotals)
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
