import { env } from 'cloudflare:test'
import { describe, it, expect, beforeEach } from 'vitest'
import { drizzle } from 'drizzle-orm/d1'
import * as schema from '../../src/db/schema-legiscan'
import { app } from '../../src/index-legiscan'
import { setupLsDb } from '../helpers/setupLsDb'

beforeEach(async () => {
  await setupLsDb()
})

// session 1: single calendar year (year inference safe); session 2: spans a boundary.
async function seed() {
  const db = drizzle(env.DB, { schema })
  await db.insert(schema.sessions).values([
    { sessionId: 1, state: 'NJ', stateId: 30, yearStart: 2026, yearEnd: 2026, sessionName: 'NJ 2026', sessionTitle: 'Regular' },
    { sessionId: 2, state: 'RI', stateId: 39, yearStart: 2025, yearEnd: 2026, sessionName: 'RI 2025-2026', sessionTitle: 'Regular' },
  ])
  // Bill in the single-year session
  await db.insert(schema.bills).values([
    { billId: 200, sessionId: 1, state: 'NJ', stateId: 30, billNumber: 'SR99', title: 'Bill 200', changeHash: 'h', status: 1 },
    { billId: 201, sessionId: 2, state: 'RI', stateId: 39, billNumber: 'H1', title: 'Bill 201', changeHash: 'h', status: 1 },
  ])
  await db.insert(schema.billSupplements).values([
    // full date embedded, structured date missing → inferred
    { supplementId: 1, billId: 200, typeId: 2, type: 'Analysis', date: '0000-00-00', title: 'Analysis', description: 'Statement SSG 5/21/26 SCS SR99', mime: 'text/html', url: 'u', stateLink: 's' },
    // present structured date → passthrough, not inferred
    { supplementId: 2, billId: 200, typeId: 1, type: 'Fiscal Note', date: '2026-04-01', title: 'Fiscal', description: 'Fiscal Note', mime: 'text/html', url: 'u', stateLink: 's' },
    // genuinely dateless → no resolved date
    { supplementId: 3, billId: 200, typeId: 7, type: 'Misc', date: '0000-00-00', title: 'Misc', description: 'Senate Bill Report', mime: 'text/html', url: 'u', stateLink: 's' },
  ])
  await db.insert(schema.billAmendments).values([
    // year-less, single-year session → inferred
    { amendmentId: 10, billId: 200, adopted: 0, chamber: 'A', date: '0000-00-00', title: 'House COW 04/08 - Floor Amend - Gutierrez', description: null, mime: 'text/html', url: 'u', stateLink: 's' },
    // year-less, boundary-spanning session → not resolvable
    { amendmentId: 11, billId: 201, adopted: 0, chamber: 'H', date: '0000-00-00', title: 'House COW 04/08 - Floor Amend', description: null, mime: 'text/html', url: 'u', stateLink: 's' },
  ])
}

describe('GET /bills/:id — embedded date recovery', () => {
  it('resolves an embedded full date on a supplement and flags it inferred', async () => {
    await seed()
    const res = await app.request('/api/bills/200', { headers: { 'x-admin-secret': 'test-secret' } }, env)
    expect(res.status).toBe(200)
    const body = await res.json() as any
    const byId = Object.fromEntries(body.supplements.map((s: any) => [s.supplementId, s]))
    expect(byId[1]).toMatchObject({ dateResolved: '2026-05-21', dateInferred: true })
    expect(byId[2]).toMatchObject({ dateResolved: '2026-04-01', dateInferred: false })
    expect(byId[3]).toMatchObject({ dateResolved: null, dateInferred: false })
  })

  it('infers a year-less amendment date in a single-year session but not a boundary-spanning one', async () => {
    await seed()
    const res200 = await app.request('/api/bills/200', { headers: { 'x-admin-secret': 'test-secret' } }, env)
    const body200 = await res200.json() as any
    expect(body200.amendments.find((a: any) => a.amendmentId === 10)).toMatchObject({ dateResolved: '2026-04-08', dateInferred: true })

    const res201 = await app.request('/api/bills/201', { headers: { 'x-admin-secret': 'test-secret' } }, env)
    const body201 = await res201.json() as any
    expect(body201.amendments.find((a: any) => a.amendmentId === 11)).toMatchObject({ dateResolved: null, dateInferred: false })
  })
})
