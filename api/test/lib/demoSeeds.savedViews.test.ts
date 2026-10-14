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
 * The fixtures stand in for what ingest gives the demo's real bills, which is only
 * the bill's state and its AI-assigned tags. Subjects are deliberately NOT given
 * here: the seed writes the subjects its views filter on (`billSubjects`), so the
 * subject half of every OR view is exercised on what the reset itself installs,
 * not on a value the test supplies.
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

async function totalFor(query: string): Promise<number> {
  const res = await app.request(`/api/bills?${query}`, { headers: { Cookie: await demoUserCookie() } }, env)
  expect(res.status, query).toBe(200)
  return ((await res.json()) as { pagination: { total: number } }).pagination.total
}

/** A view that joins subjects and tags with `match=any`, split into its two halves;
 *  null for any other view. A one-dimension query needs no `match`. */
function orHalves(query: string): { subjectOnly: string; tagOnly: string } | null {
  const p = new URLSearchParams(query)
  const subjects = p.getAll('subject')
  const tags = p.getAll('tag')
  if (p.get('match') !== 'any' || subjects.length === 0 || tags.length === 0) return null
  return {
    subjectOnly: new URLSearchParams(subjects.map((v): [string, string] => ['subject', v])).toString(),
    tagOnly: new URLSearchParams(tags.map((v): [string, string] => ['tag', v])).toString(),
  }
}

async function seedFixtures(seed: DemoSeed, fixtures: BillFixture[]) {
  for (const [i, f] of fixtures.entries()) {
    await seedBill({
      externalId: f.externalId, billNumber: `B${1000 + i}`, title: `Bill ${i}`,
      state: f.state, tags: f.tags,
    })
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
    expect(views.filter(v => orHalves(v.query) !== null).length).toBeGreaterThanOrEqual(1)
  })

  // The OR operator hides which half carried a result, so each half is asked alone.
  // A subject or tag that matches no bill passes the combined query silently, and
  // the demo's OR view degrades to a one-sided view nobody notices.
  it('returns bills from the subject half and the tag half of every OR view, each on its own', async () => {
    const orViews = (await listViews()).filter(v => orHalves(v.query) !== null)
    expect(orViews.length).toBeGreaterThanOrEqual(1)
    for (const v of orViews) {
      const { subjectOnly, tagOnly } = orHalves(v.query)!
      expect(await totalFor(subjectOnly), `${v.name}: subjects alone (${subjectOnly})`).toBeGreaterThanOrEqual(1)
      expect(await totalFor(tagOnly), `${v.name}: tags alone (${tagOnly})`).toBeGreaterThanOrEqual(1)
    }
  })

  // An OR view that returns every bill shows nothing about the operator.
  it('has OR views that narrow the list', async () => {
    const orViews = (await listViews()).filter(v => orHalves(v.query) !== null)
    expect(orViews.length).toBeGreaterThanOrEqual(1)
    for (const v of orViews) {
      expect(await totalFor(v.query), v.name).toBeLessThan(fixtures.length)
    }
  })

  // The bill page lists bills.subjects; the list filter and facets read bill_subjects.
  it('writes each seeded subject to both subject stores', async () => {
    expect(seed.billSubjects?.length ?? 0).toBeGreaterThan(0)
    for (const { externalId, subject } of seed.billSubjects ?? []) {
      const row = await env.DB.prepare(
        `SELECT (SELECT count(*) FROM bill_subjects bs WHERE bs.bill_id = b.id AND bs.subject_name = ? AND bs.state = b.state) AS filterRows,
                (SELECT count(*) FROM json_each(b.subjects) WHERE value = ?) AS listed
         FROM bills b WHERE b.external_id = ?`,
      ).bind(subject, subject, externalId).first<{ filterRows: number; listed: number }>()
      expect(row, externalId).not.toBeNull()
      expect(row!.filterRows, `${externalId} bill_subjects`).toBe(1)
      expect(row!.listed, `${externalId} bills.subjects`).toBe(1)
    }
  })

  it('returns at least one bill from every view', async () => {
    const views = await listViews()
    expect(views.length).toBeGreaterThan(0)
    for (const v of views) {
      expect(await totalFor(v.query), `${v.name} (${v.query})`).toBeGreaterThanOrEqual(1)
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
    // Writing the subjects twice must not duplicate them.
    const dupes = await env.DB.prepare(
      `SELECT count(*) AS n FROM (SELECT 1 FROM bills b, json_each(b.subjects) je GROUP BY b.id, je.value HAVING count(*) > 1)`,
    ).first<{ n: number }>()
    expect(dupes!.n).toBe(0)
  })
})
