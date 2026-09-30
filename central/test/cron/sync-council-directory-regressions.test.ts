// Regressions from the adversarial review of the dccouncil.gov directory sync.
import { env } from 'cloudflare:test'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { drizzle } from 'drizzle-orm/d1'
import * as schema from '../../src/db/schema-legiscan'
import { setupLsDb } from '../helpers/setupLsDb'
import youthRaw from '../fixtures/dccouncil/committee-youth-affairs.html?raw'
import dirRaw from '../fixtures/dccouncil/council-directory-1.html?raw'
import { syncCouncilDirectory } from '../../src/cron/sync-lims'
import { app } from '../../src/index-legiscan'
import { eq } from 'drizzle-orm'

// Each directory page gets distinct people, as the real directory has (about 190 across 10 pages).
function pageOf(url: string, html: string): string {
  const n = /\/page\/(\d+)\//.exec(url)?.[1] ?? '1'
  return html.replace(/mailto:([A-Za-z0-9._%+-]+)@dccouncil\.gov/g, `mailto:$1.p${n}@dccouncil.gov`)
}

const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)

beforeEach(async () => {
  await setupLsDb()
  fetchMock.mockReset()
})

const SLUGS = ['c-one', 'c-two', 'c-three', 'c-four', 'c-five', 'c-six']
const index = `<html><body><main>${SLUGS.map(s => `<a href="https://dccouncil.gov/committees/${s}/">${s}</a>`).join('')}</main></body></html>`
// Two directory pages (80 entries): drop the links to pages 3..10.

function serve(opts: { failSlug?: string; failDirectory?: boolean; youth?: string; directory?: string } = {}) {
  fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input)
    if (url === 'https://dccouncil.gov/committees/') return new Response(index, { status: 200 })
    if (opts.failSlug && url.includes(`/committees/${opts.failSlug}/`)) return new Response('bad gateway', { status: 502 })
    if (url.includes('/committees/')) return new Response(opts.youth ?? youthRaw, { status: 200 })
    if (url.includes('/council-directory/')) {
      if (opts.failDirectory) return new Response('down', { status: 503 })
      return new Response(pageOf(url, opts.directory ?? dirRaw), { status: 200 })
    }
    return new Response('not found', { status: 404 })
  })
}

describe('syncCouncilDirectory (review regressions)', () => {
  it('a transient failure on ONE committee page keeps that committee (plausibility guard is only a count)', async () => {
    const db = drizzle(env.DB, { schema })
    serve()
    await syncCouncilDirectory(db)
    expect((await db.select().from(schema.councilCommittees).all()).map(r => r.slug).sort()).toEqual([...SLUGS].sort())
    serve({ failSlug: 'c-three' })
    await syncCouncilDirectory(db)
    const slugs = (await db.select().from(schema.councilCommittees).all()).map(r => r.slug)
    expect(slugs).toContain('c-three')
  }, 60_000)

  it('a directory failure does not discard the fresh committee fetch', async () => {
    const db = drizzle(env.DB, { schema })
    serve()
    await syncCouncilDirectory(db)
    serve({ failDirectory: true, youth: youthRaw.replaceAll('Committee on Youth Affairs', 'Committee on Youth Affairs (renamed)') })
    await syncCouncilDirectory(db).catch(() => {})
    const names = (await db.select().from(schema.councilCommittees).all()).map(r => r.name)
    expect(names.every(n => n.includes('(renamed)'))).toBe(true)
  }, 60_000)

  it('two different staffers who share an office mailbox are both stored', async () => {
    const db = drizzle(env.DB, { schema })
    const card = (name: string, email: string) => `<article class="listing-post listing-grid__card column">
      <p class="h4 byline text-small card-rule">staff</p><h3>${name}</h3>
      <p class="byline">Staff Assistant <br><span class="byline-label">Office:</span> <span class="case-cap">councilmember X</span><br>
      <a href="mailto:${email}"><span class="byline-label">Email: </span>${email}</a><br></p></article>`
    const cards = Array.from({ length: 58 }, (_, i) => card(`Person ${i}`, `p${i}@dccouncil.gov`))
    cards.push(card('Alice Shared', 'ward9@dccouncil.gov'), card('Bob Shared', 'ward9@dccouncil.gov'))
    serve({ directory: `<html><body>${cards.join('\n')}</body></html>` })
    await syncCouncilDirectory(db)
    const names = (await db.select().from(schema.councilDirectory).all()).map(r => r.name)
    expect(names).toContain('Alice Shared')
    expect(names).toContain('Bob Shared')
  }, 60_000)

  it('records a chair change and closes the old roster in the history, after a first sync that only sets the baseline', async () => {
    const db = drizzle(env.DB, { schema })
    serve()
    await syncCouncilDirectory(db)
    expect(await db.select().from(schema.councilChanges).all()).toEqual([])
    const history = await db.select().from(schema.councilCommitteeHistory).all()
    expect(history.length).toBe(SLUGS.length)
    expect(history.every(h => h.validTo === null)).toBe(true)

    serve({ youth: youthRaw.replace('Ward 5 Councilmember Zachary Parker </a>', 'Ward 2 Councilmember Brooke Pinto </a>') })
    await syncCouncilDirectory(db)
    const changes = await db.select().from(schema.councilChanges).all()
    expect(changes.filter(c => c.kind === 'chair_changed').map(c => c.person)).toContain('Ward 2 Councilmember Brooke Pinto')
    const rows = await db.select().from(schema.councilCommitteeHistory).where(eq(schema.councilCommitteeHistory.slug, 'c-one')).all()
    expect(rows).toHaveLength(2)
    expect(rows.filter(r => r.validTo === null).map(r => r.chair)).toEqual(['Ward 2 Councilmember Brooke Pinto'])
  }, 120_000)
})

describe('council directory endpoint', () => {
  it('lists current and former members with terms, and recent changes', async () => {
    const db = drizzle(env.DB, { schema })
    await db.insert(schema.sessions).values({ sessionId: 1_000_000_026, state: 'DC', stateId: 9, yearStart: 2025, yearEnd: 2026, sessionName: '2025-2026 Council Period 26', sessionTitle: 'CP26', prior: 0 } as any)
    await db.insert(schema.people).values([
      { peopleId: 1_000_000_192, name: 'Kenyan R. McDuffie', stateId: 9, role: 'Councilmember', termStart: '2023-01-02', termEnd: '2026-01-05' },
      { peopleId: 1_000_000_194, name: 'Zachary Parker', stateId: 9, role: 'Councilmember', termStart: '2023-01-02', termEnd: '2099-01-01' },
    ] as any)
    await db.insert(schema.councilChanges).values({ kind: 'member_left', person: 'Kenyan R. McDuffie', detail: 'Term ended 2026-01-05.', detectedAt: new Date().toISOString().slice(0, 19).replace('T', ' ') })
    const res = await app.request('/api/bills/council-directory', { headers: { 'x-admin-secret': 'test-secret' } }, env)
    const body = await res.json() as any
    expect(body.councilmembers.map((m: any) => [m.name, m.current])).toEqual([['Zachary Parker', true], ['Kenyan R. McDuffie', false]])
    expect(body.changes).toEqual([expect.objectContaining({ kind: 'member_left', person: 'Kenyan R. McDuffie' })])
  })
})

