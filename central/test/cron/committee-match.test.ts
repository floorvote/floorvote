import { env } from 'cloudflare:test'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { drizzle } from 'drizzle-orm/d1'
import { and, eq } from 'drizzle-orm'
import * as schema from '../../src/db/schema'
import { sessions, bills, billTenants, tenants, keywordRegistry, committees, billReferrals, committeeRegistry } from '../../src/db/schema'
import { applyMasterList } from '../../src/cron/sync'
import { app } from '../../src/index-legiscan'
import type { SyncEntry } from '../../src/providers/types'
import { clearDb } from '../helpers/migrations'

// #471: a bill referred to a committee an instance picked is fully analyzed there,
// as a keyword match is, on every path that matches keywords: the full pass,
// the keyword re-run an instance asks for after saving, and a seed.

vi.mock('../../src/lib/queuesRest', () => ({
  publishBatch: vi.fn().mockResolvedValue(undefined),
  publishMessage: vi.fn().mockResolvedValue(undefined),
  queuesRestEnabled: () => true,
  resolveQueueId: vi.fn().mockResolvedValue('q-1'),
  ensureQueue: vi.fn().mockResolvedValue('q-1'),
}))

const SESSION = { sessionId: 9200, state: 'RI', sessionName: 'Test', provider: 'legiscan' }
const AUTH = { 'x-admin-secret': 'sek', 'content-type': 'application/json' }
const JUDICIARY = 501
const RULES = 502

function entry(billId: number, title: string, lastAction: string | null = null, hash = `h${billId}`): SyncEntry {
  return { bill_id: billId, number: `HB ${billId}`, change_hash: hash, title, description: '', last_action: lastAction ?? undefined }
}

function storedBill(billId: number, title: string, extra: Partial<typeof bills.$inferInsert> = {}) {
  return {
    billId, changeHash: `h${billId}`, sessionId: SESSION.sessionId, state: 'RI', provider: 'legiscan',
    stateId: 0, billNumber: `HB ${billId}`, title, status: 1, ...extra,
  }
}

async function pass(list: SyncEntry[]) {
  const db = drizzle(env.DB, { schema })
  const sendBatch = vi.fn().mockResolvedValue(undefined)
  const queue = { sendBatch, send: vi.fn() } as unknown as Queue
  await applyMasterList(SESSION, list, [{ tenantId: 't-a', stateCoverage: '["RI"]', queueId: null }], { ...(env as any) }, db, queue)
  const queued = new Set<number>()
  for (const call of sendBatch.mock.calls) for (const m of call[0]) queued.add(m.body.billId)
  return queued
}

async function linkOf(billId: number) {
  const db = drizzle(env.DB, { schema })
  return (await db.select({ matchType: billTenants.matchType }).from(billTenants)
    .where(and(eq(billTenants.billId, billId), eq(billTenants.tenantId, 't-a'))).get())?.matchType
}

beforeEach(async () => {
  await clearDb()
  vi.clearAllMocks()
  const db = drizzle(env.DB, { schema })
  await db.insert(sessions).values({
    sessionId: SESSION.sessionId, state: 'RI', stateId: 0, yearStart: 2026, yearEnd: 2026, sessionTitle: 'Test', sessionName: 'Test',
  })
  await db.insert(tenants).values({ tenantId: 't-a', name: 't-a', stateCoverage: '["RI"]', active: true })
  await db.insert(keywordRegistry).values({ tenantId: 't-a', keyword: 'voter' })
  await db.insert(committees).values([
    { committeeId: JUDICIARY, state: 'RI', sessionId: SESSION.sessionId, chamber: 'H', name: 'Judiciary' },
    { committeeId: RULES, state: 'RI', sessionId: SESSION.sessionId, chamber: 'H', name: 'Rules' },
  ])
})

describe('the full pass matches bills referred to a picked committee', () => {
  it('matches and queues a bill whose stored referral names the committee, besides keyword matches', async () => {
    const db = drizzle(env.DB, { schema })
    await db.insert(committeeRegistry).values({ tenantId: 't-a', committeeId: JUDICIARY })
    await db.insert(bills).values([storedBill(1, 'Court Fees'), storedBill(2, 'Parks'), storedBill(3, 'Voter Rolls')])
    await db.insert(billReferrals).values({ id: 'r1', billId: 1, date: '2026-01-05', committeeId: JUDICIARY, chamber: 'H', name: 'Judiciary' })
    await db.insert(billTenants).values([1, 2, 3].map(billId => ({ billId, tenantId: 't-a', matchType: null })))

    const queued = await pass([entry(1, 'Court Fees'), entry(2, 'Parks'), entry(3, 'Voter Rolls')])

    expect(await linkOf(1)).toBe('keyword')
    expect(await linkOf(2)).toBeNull()
    expect(await linkOf(3)).toBe('keyword')
    expect(queued.has(1)).toBe(true)
    expect(queued.has(2)).toBe(false)
  })

  it('matches a bill pending in the committee', async () => {
    const db = drizzle(env.DB, { schema })
    await db.insert(committeeRegistry).values({ tenantId: 't-a', committeeId: JUDICIARY })
    await db.insert(bills).values(storedBill(4, 'Court Fees', { pendingCommitteeId: JUDICIARY }))
    await db.insert(billTenants).values({ billId: 4, tenantId: 't-a', matchType: null })

    await pass([entry(4, 'Court Fees')])

    expect(await linkOf(4)).toBe('keyword')
  })

  it("matches a bill new to central by the committee its last action refers it to", async () => {
    const db = drizzle(env.DB, { schema })
    await db.insert(committeeRegistry).values({ tenantId: 't-a', committeeId: JUDICIARY })

    const queued = await pass([entry(5, 'Court Fees', 'Introduced, referred to House Judiciary'), entry(6, 'Parks', 'Introduced, referred to House Finance')])

    expect(await linkOf(5)).toBe('keyword')
    expect(await linkOf(6)).toBeNull()
    expect(queued.has(5)).toBe(true)
    expect(queued.has(6)).toBe(false)
  })

  it('matches nothing by committee for an instance that picked none', async () => {
    const db = drizzle(env.DB, { schema })
    await db.insert(bills).values(storedBill(7, 'Court Fees', { pendingCommitteeId: JUDICIARY }))

    await pass([entry(7, 'Court Fees', 'Referred to House Judiciary')])

    expect(await linkOf(7)).toBeNull()
  })
})

describe('the routes an instance calls keep committee matches', () => {
  const env2 = () => {
    const sendBatch = vi.fn().mockResolvedValue(undefined)
    return { env: { ...(env as any), ADMIN_SECRET: 'sek', INGESTOR_QUEUE: { sendBatch, send: vi.fn() } }, sendBatch }
  }

  it('register stores the committees an instance picked, and an empty list clears them', async () => {
    const db = drizzle(env.DB, { schema })
    const register = (committeeIds: string[]) => app.fetch(new Request('http://central/api/tenants/register', {
      method: 'POST', headers: AUTH,
      body: JSON.stringify({ tenantId: 't-a', name: 't-a', apiUrl: 'https://t-a.example.com', stateCoverage: ['RI'], committees: committeeIds }),
    }), { ...(env as any), ADMIN_SECRET: 'sek' })

    expect((await register([String(JUDICIARY), String(RULES)])).status).toBe(200)
    const rows = await db.select({ id: committeeRegistry.committeeId }).from(committeeRegistry).where(eq(committeeRegistry.tenantId, 't-a')).all()
    expect(rows.map(r => r.id).sort()).toEqual([JUDICIARY, RULES])

    expect((await register([])).status).toBe(200)
    expect(await db.select().from(committeeRegistry).all()).toEqual([])
  })

  it('the keyword re-run promotes and queues a bill referred to a picked committee', async () => {
    const db = drizzle(env.DB, { schema })
    await db.insert(committeeRegistry).values({ tenantId: 't-a', committeeId: JUDICIARY })
    await db.insert(bills).values([storedBill(10, 'Court Fees'), storedBill(11, 'Parks')])
    await db.insert(billReferrals).values({ id: 'r10', billId: 10, date: '2026-01-05', committeeId: JUDICIARY, chamber: 'H', name: 'Judiciary' })
    await db.insert(billTenants).values([10, 11].map(billId => ({ billId, tenantId: 't-a', matchType: null })))
    const { env: e, sendBatch } = env2()

    const res = await app.request('/api/admin/sync-keywords/t-a', { method: 'POST', headers: AUTH }, e)

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ newlyMatched: 1 })
    expect(await linkOf(10)).toBe('keyword')
    expect(await linkOf(11)).toBeNull()
    expect(sendBatch.mock.calls.flatMap(c => c[0].map((m: any) => m.body.billId))).toEqual([10])
  })

  it('a seed keeps a committee match it would otherwise demote', async () => {
    const db = drizzle(env.DB, { schema })
    await db.insert(committeeRegistry).values({ tenantId: 't-a', committeeId: JUDICIARY })
    await db.insert(bills).values(storedBill(12, 'Court Fees', { pendingCommitteeId: JUDICIARY }))
    await db.insert(billTenants).values({ billId: 12, tenantId: 't-a', matchType: 'keyword' })

    const res = await app.request(`/api/tenants/seed-session/t-a?sessionId=${SESSION.sessionId}&skipQueue=true`,
      { method: 'POST', headers: AUTH }, { ...(env as any), ADMIN_SECRET: 'sek' })

    expect(res.status).toBe(200)
    expect(await linkOf(12)).toBe('keyword')
  })
})
