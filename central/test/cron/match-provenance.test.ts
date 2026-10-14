import { env } from 'cloudflare:test'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { drizzle } from 'drizzle-orm/d1'
import * as schema from '../../src/db/schema'
import { sessions, bills, billTenants, tenants, keywordRegistry } from '../../src/db/schema'
import { applyMasterList } from '../../src/cron/sync'
import type { SyncEntry } from '../../src/providers/types'
import { setupLsDb } from '../helpers/setupLsDb'

// Seam 2 of #363: every path that links a bill to an instance with a keyword
// match declares the match routine or bulk on the ingestor message, per
// instance. This file covers the sync (applyMasterList). The seed, keyword
// re-run, backfill, and import paths are covered beside their routes.

vi.mock('../../src/lib/queuesRest', () => ({
  publishBatch: vi.fn().mockResolvedValue(undefined),
  publishMessage: vi.fn().mockResolvedValue(undefined),
  queuesRestEnabled: () => true,
}))

const SESSION = { sessionId: 9100, state: 'DC', sessionName: 'Test', provider: 'legiscan' }

function entry(billId: number, title: string, hash = `h${billId}`): SyncEntry {
  return { bill_id: billId, number: `B-${billId}`, change_hash: hash, title, description: '' }
}

function storedBill(billId: number, title: string, changeHash = `h${billId}`) {
  return {
    billId, changeHash, sessionId: SESSION.sessionId, state: 'DC', provider: 'legiscan',
    stateId: 0, billNumber: `B-${billId}`, title, status: 1,
  }
}

function covering(...ids: string[]) {
  return ids.map(tenantId => ({ tenantId, stateCoverage: '["DC"]', queueId: null }))
}

/** The ingestor messages a pass sent, by bill id. */
function queued(sendBatch: ReturnType<typeof vi.fn>): Map<number, any> {
  const out = new Map<number, any>()
  for (const call of sendBatch.mock.calls) for (const m of call[0]) out.set(m.body.billId, m.body)
  return out
}

async function pass(list: SyncEntry[], tenantIds: string[]) {
  const db = drizzle(env.DB, { schema })
  const sendBatch = vi.fn().mockResolvedValue(undefined)
  const queue = { sendBatch, send: vi.fn() } as unknown as Queue
  await applyMasterList(SESSION, list, covering(...tenantIds), { ...(env as any) }, db, queue)
  return queued(sendBatch)
}

beforeEach(async () => {
  await setupLsDb()
  vi.clearAllMocks()
  const db = drizzle(env.DB, { schema })
  await db.insert(sessions).values({
    sessionId: SESSION.sessionId, state: 'DC', stateId: 0, yearStart: 2025, yearEnd: 2026,
    sessionTitle: 'Test', sessionName: 'Test',
  })
  for (const tenantId of ['t-a', 't-b']) {
    await db.insert(tenants).values({ tenantId, name: tenantId, stateCoverage: '["DC"]', active: true })
    await db.insert(keywordRegistry).values({ tenantId, keyword: 'voter' })
  }
})

describe('applyMasterList declares each new keyword match routine or bulk', () => {
  it('declares routine for a bill new to central, for an instance that already holds bills of the session', async () => {
    const db = drizzle(env.DB, { schema })
    await db.insert(bills).values(storedBill(1, 'Voter Rolls Act'))
    await db.insert(billTenants).values({ billId: 1, tenantId: 't-a', matchType: 'keyword' })

    const msgs = await pass([entry(1, 'Voter Rolls Act'), entry(2, 'Voter ID Act')], ['t-a'])

    expect(msgs.get(2)?.matchProvenance).toEqual({ 't-a': 'routine' })
  })

  it("declares bulk on an instance's first pass over a session, which seeds it", async () => {
    const msgs = await pass([entry(1, 'Voter Rolls Act'), entry(2, 'Voter ID Act')], ['t-a'])

    expect(msgs.get(1)?.matchProvenance).toEqual({ 't-a': 'bulk' })
    expect(msgs.get(2)?.matchProvenance).toEqual({ 't-a': 'bulk' })
  })

  it('declares bulk for a bill central already held that the instance had no link to', async () => {
    const db = drizzle(env.DB, { schema })
    await db.insert(bills).values([storedBill(1, 'Bridge Naming'), storedBill(3, 'Voter ID Act')])
    await db.insert(billTenants).values({ billId: 1, tenantId: 't-a', matchType: null })

    const msgs = await pass([entry(1, 'Bridge Naming'), entry(3, 'Voter ID Act')], ['t-a'])

    expect(msgs.get(3)?.matchProvenance).toEqual({ 't-a': 'bulk' })
  })

  it('declares bulk when an existing monitored link starts to match', async () => {
    const db = drizzle(env.DB, { schema })
    await db.insert(bills).values(storedBill(4, 'Bridge Naming'))
    await db.insert(billTenants).values({ billId: 4, tenantId: 't-a', matchType: null })

    const msgs = await pass([entry(4, 'Voter Bridge Naming', 'h4-new')], ['t-a'])

    expect(msgs.get(4)?.matchProvenance).toEqual({ 't-a': 'bulk' })
  })

  it('declares routine for a bill only the raw pass has stored so far', async () => {
    const db = drizzle(env.DB, { schema })
    await db.insert(bills).values([storedBill(1, 'Bridge Naming'), storedBill(5, 'B-5', '')])
    await db.insert(billTenants).values({ billId: 1, tenantId: 't-a', matchType: null })

    const msgs = await pass([entry(1, 'Bridge Naming'), entry(5, 'Voter ID Act')], ['t-a'])

    expect(msgs.get(5)?.matchProvenance).toEqual({ 't-a': 'routine' })
  })

  it('declares per instance, so one message can carry routine for one and bulk for another', async () => {
    const db = drizzle(env.DB, { schema })
    await db.insert(bills).values(storedBill(1, 'Bridge Naming'))
    await db.insert(billTenants).values({ billId: 1, tenantId: 't-a', matchType: null })

    const msgs = await pass([entry(1, 'Bridge Naming'), entry(6, 'Voter ID Act')], ['t-a', 't-b'])

    expect(msgs.get(6)?.matchProvenance).toEqual({ 't-a': 'routine', 't-b': 'bulk' })
  })

  it('declares nothing for a matched bill that only changed', async () => {
    const db = drizzle(env.DB, { schema })
    await db.insert(bills).values(storedBill(7, 'Voter ID Act'))
    await db.insert(billTenants).values({ billId: 7, tenantId: 't-a', matchType: 'keyword' })

    const msgs = await pass([entry(7, 'Voter ID Act', 'h7-new')], ['t-a'])

    expect(msgs.has(7)).toBe(true)
    expect(msgs.get(7)?.matchProvenance).toBeUndefined()
  })
})
