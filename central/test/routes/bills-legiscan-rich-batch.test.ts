import { env } from 'cloudflare:test'
import { describe, it, expect, beforeEach } from 'vitest'
import { drizzle } from 'drizzle-orm/d1'
import * as schema from '../../src/db/schema-legiscan'
import { app } from '../../src/index-legiscan'
import { setupLsDb } from '../helpers/setupLsDb'

beforeEach(async () => {
  await setupLsDb()
})

async function seed() {
  const db = drizzle(env.DB, { schema })
  await db.insert(schema.sessions).values([
    { sessionId: 1, state: 'RI', stateId: 39, yearStart: 2026, yearEnd: 2026, sessionName: 'RI 2026', sessionTitle: 'Regular' },
  ])
  await db.insert(schema.bills).values([
    { billId: 101, sessionId: 1, state: 'RI', stateId: 0, billNumber: 'H101', title: 'Bill 101', changeHash: 'h', status: 1 },
    { billId: 102, sessionId: 1, state: 'RI', stateId: 0, billNumber: 'H102', title: 'Bill 102', changeHash: 'h', status: 1 },
  ])
  await db.insert(schema.billAmendments).values([
    { amendmentId: 11, billId: 101, adopted: 1, chamber: 'H', date: '2026-01-02', title: 'Amd A', description: 'd', mime: 'application/pdf', url: 'u', stateLink: 's' },
  ])
  await db.insert(schema.billSupplements).values([
    { supplementId: 21, billId: 101, typeId: 1, type: 'Fiscal Note', date: '2026-01-03', title: 'Sup A', description: 'd', mime: 'application/pdf', url: 'u', stateLink: 's' },
    { supplementId: 22, billId: 102, typeId: 2, type: 'Analysis', date: '2026-01-04', title: 'Sup B', description: 'd', mime: 'application/pdf', url: 'u', stateLink: 's' },
    // missing structured date, but description carries a full date → inferred
    { supplementId: 23, billId: 102, typeId: 2, type: 'Analysis', date: '0000-00-00', title: 'Analysis', description: 'Statement SSG 5/21/26', mime: 'text/html', url: 'u', stateLink: 's' },
  ])
  await db.insert(schema.rollCalls).values([
    { rollCallId: 31, billId: 102, date: '2026-01-05', description: 'Passage', yea: 40, nay: 10, nv: 2, absent: 1, total: 53, passed: 1, chamber: 'H' },
  ])
}

describe('POST /bills/rich-batch', () => {
  it('returns 401 without admin secret', async () => {
    const res = await app.request('/api/bills/rich-batch', { method: 'POST', body: '{}' }, env)
    expect(res.status).toBe(401)
  })

  it('returns amendments, supplements, and votes grouped by bill id', async () => {
    await seed()
    const res = await app.request(
      '/api/bills/rich-batch',
      {
        method: 'POST',
        headers: { 'x-admin-secret': 'test-secret', 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: ['legiscan:101', 102] }),
      },
      env,
    )
    expect(res.status).toBe(200)
    const body = await res.json() as any

    expect(body.byId['101'].amendments).toHaveLength(1)
    expect(body.byId['101'].amendments[0]).toMatchObject({ amendmentId: 11, adopted: true, chamber: 'H' })
    expect(body.byId['101'].supplements).toHaveLength(1)
    expect(body.byId['101'].supplements[0]).toMatchObject({ supplementId: 21, type: 'Fiscal Note' })
    expect(body.byId['101'].votes).toHaveLength(0)

    expect(body.byId['102'].supplements).toHaveLength(2)
    expect(body.byId['102'].votes).toHaveLength(1)
    expect(body.byId['102'].votes[0]).toMatchObject({ id: '31', result: 'pass', chamber: 'H' })
    expect(body.byId['102'].votes[0].counts).toEqual([
      { option: 'yes', value: 40 },
      { option: 'no', value: 10 },
      { option: 'not voting', value: 2 },
      { option: 'absent', value: 1 },
    ])
  })

  it('includes empty entries for ids with no rich data', async () => {
    await seed()
    const res = await app.request(
      '/api/bills/rich-batch',
      {
        method: 'POST',
        headers: { 'x-admin-secret': 'test-secret', 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [999] }),
      },
      env,
    )
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.byId['999']).toEqual({ amendments: [], supplements: [], votes: [] })
  })

  it('resolves embedded dates and flags inferred rows', async () => {
    await seed()
    const res = await app.request(
      '/api/bills/rich-batch',
      {
        method: 'POST',
        headers: { 'x-admin-secret': 'test-secret', 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [101, 102] }),
      },
      env,
    )
    expect(res.status).toBe(200)
    const body = await res.json() as any
    // present structured date → passthrough, not inferred
    const sup21 = body.byId['101'].supplements.find((s: any) => s.supplementId === 21)
    expect(sup21).toMatchObject({ dateResolved: '2026-01-03', dateInferred: false })
    // 0000-00-00 + full date in description → inferred (year inference needs the session join)
    const sup23 = body.byId['102'].supplements.find((s: any) => s.supplementId === 23)
    expect(sup23).toMatchObject({ dateResolved: '2026-05-21', dateInferred: true })
  })
})
