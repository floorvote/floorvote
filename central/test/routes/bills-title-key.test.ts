import { env } from 'cloudflare:test'
import { describe, it, expect, beforeEach } from 'vitest'
import { drizzle } from 'drizzle-orm/d1'
import * as schema from '../../src/db/schema'
import { app } from '../../src/index-legiscan'
import { setupLsDb } from '../helpers/setupLsDb'
import { titleKey } from '../../../shared/titleCompanions'

// GET /bills/:id serves each bill's title key (#521): the key instances store
// and look companions up by, or null where no suggestion can come from the
// bill. Central computes it on every read from the vocabulary of the bill's
// provider, so opting a state in or out reaches instances on each bill's next
// delivery, and on every page view at once, with nothing stored in central.

beforeEach(async () => {
  await setupLsDb()
})

const TITLE = 'An act relating to elections and the registration of voters'

async function seedBill(billId: number, state: string, fields: { billType?: string; body?: string; title?: string; provider?: string } = {}) {
  const db = drizzle(env.DB, { schema })
  await db.insert(schema.sessions).values({ sessionId: billId, state, stateId: 1, yearStart: 2026, yearEnd: 2027, sessionName: `${state} 2026`, sessionTitle: 'Regular' })
  await db.insert(schema.bills).values({
    billId, sessionId: billId, state, stateId: 1, provider: fields.provider ?? 'legiscan', billNumber: `X${billId}`,
    title: fields.title ?? TITLE, billType: fields.billType ?? 'B', body: fields.body ?? 'H', changeHash: 'h', status: 1,
  })
}

async function served(billId: number) {
  const res = await app.request(`/api/bills/${billId}`, { headers: { 'x-admin-secret': 'test-secret' } }, env)
  expect(res.status).toBe(200)
  return await res.json() as { titleKey?: string | null; body?: string | null }
}

describe('GET /bills/:id: the title key', () => {
  it('serves the key for a bill in an opted-in state, as the shared matcher computes it', async () => {
    await seedBill(1, 'PA', { body: 'S' })
    const bill = await served(1)
    expect(bill.titleKey).toBe(titleKey({ title: TITLE, billType: 'B', chamber: 'S' }, ['B']))
    expect(bill.titleKey).toEqual(expect.any(String))
    expect(bill.body).toBe('S')
  })

  it('serves null for a bill in a state that is not opted in', async () => {
    await seedBill(1, 'PA')
    await seedBill(2, 'NJ')
    await seedBill(3, 'CA')
    expect((await served(1)).titleKey).toEqual(expect.any(String))
    expect((await served(2)).titleKey).toBeNull()
    expect((await served(3)).titleKey).toBeNull()
  })

  it('serves null for a resolution, a stub, and a short title', async () => {
    await seedBill(1, 'PA')
    await seedBill(2, 'PA', { billType: 'R' })
    await seedBill(3, 'PA', { body: '' })
    await seedBill(4, 'PA', { title: 'Elections' })
    expect((await served(1)).titleKey).toEqual(expect.any(String))
    expect((await served(2)).titleKey).toBeNull()
    expect((await served(3)).titleKey).toBeNull()
    expect((await served(4)).titleKey).toBeNull()
  })
})
