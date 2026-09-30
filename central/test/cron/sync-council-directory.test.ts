import { env } from 'cloudflare:test'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { drizzle } from 'drizzle-orm/d1'
import * as schema from '../../src/db/schema-legiscan'
import { setupLsDb } from '../helpers/setupLsDb'
import youthRaw from '../fixtures/dccouncil/committee-youth-affairs.html?raw'
import dirRaw from '../fixtures/dccouncil/council-directory-1.html?raw'
import indexRaw from '../fixtures/dccouncil/committees-index.html?raw'
import { syncCouncilDirectory } from '../../src/cron/sync-lims'

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

function serve(opts: { committeePage?: string; failDirectory?: boolean } = {}) {
  fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input)
    if (url === 'https://dccouncil.gov/committees/') return new Response(indexRaw, { status: 200 })
    if (url.includes('/committees/')) return new Response(opts.committeePage ?? youthRaw, { status: 200 })
    if (url.includes('/council-directory/')) return opts.failDirectory ? new Response('down', { status: 503 }) : new Response(pageOf(url, dirRaw), { status: 200 })
    return new Response('not found', { status: 404 })
  })
}

describe('syncCouncilDirectory', () => {
  it('stores committees and the staff directory', async () => {
    serve()
    const db = drizzle(env.DB, { schema })
    const r = await syncCouncilDirectory(db)
    // The index lists the 11 current committees; the sitemap's defunct ones (COVID-19 recovery, redistricting) are left out.
    expect(r.committees).toBe(11)
    expect((await db.select().from(schema.councilCommittees).all()).some(c => /covid|redistricting/i.test(c.slug))).toBe(false)
    const youth = await db.select().from(schema.councilCommittees).all()
    expect(youth.length).toBe(r.committees)
    expect(JSON.parse(youth[0].staffJson)[0]).toMatchObject({ name: 'Thomas Franco', email: 'tfranco@dccouncil.gov' })
    const people = await db.select().from(schema.councilDirectory).all()
    expect(people.length).toBeGreaterThanOrEqual(15)
    expect(people.find(p => p.email === 'erodriguezlabrada.p1@dccouncil.gov')).toMatchObject({ title: 'Deputy Committee Director', office: 'councilmember Pinto' })
  }, 60_000)

  it('keeps the stored rows when a fetch comes back empty or fails', async () => {
    serve()
    const db = drizzle(env.DB, { schema })
    await syncCouncilDirectory(db)
    const before = (await db.select().from(schema.councilCommittees).all()).length
    serve({ committeePage: '<html><body>redesigned</body></html>' })
    await expect(syncCouncilDirectory(db)).resolves.toMatchObject({ committees: 0 })
    expect((await db.select().from(schema.councilCommittees).all()).length).toBe(before)
    serve({ failDirectory: true })
    await expect(syncCouncilDirectory(db)).rejects.toThrow(/HTTP 503/)
    expect((await db.select().from(schema.councilDirectory).all()).length).toBeGreaterThan(0)
  }, 120_000)
})
