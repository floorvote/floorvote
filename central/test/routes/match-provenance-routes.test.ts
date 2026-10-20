import { env } from 'cloudflare:test'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { drizzle } from 'drizzle-orm/d1'
import * as schema from '../../src/db/schema'
import { app } from '../../src/index'
import { clearDb } from '../helpers/migrations'

// Seam 2 of #363: the operator and instance routes that turn bills into keyword
// matches in bulk declare those matches bulk. The sync's own declarations are
// covered in test/cron/match-provenance.test.ts.

vi.mock('../../src/lib/queuesRest', () => ({
  publishBatch: vi.fn().mockResolvedValue(undefined),
  publishMessage: vi.fn().mockResolvedValue(undefined),
  queuesRestEnabled: () => true,
}))

const AUTH = { 'x-admin-secret': 'test-secret', 'content-type': 'application/json' }

let tenantSeq = 0

/** A tenant with one monitored (unmatched) link to a bill its keyword matches. */
async function seed() {
  const db = drizzle(env.DB, { schema })
  // sync-keywords has a 60-second cooldown per tenant, so each test gets its own.
  const tenantId = `prov-${++tenantSeq}`
  await db.insert(schema.tenants).values({ tenantId, name: tenantId, active: true, stateCoverage: '["RI"]' })
  await db.insert(schema.sessions).values({
    sessionId: 1, state: 'RI', stateId: 0, yearStart: 2026, yearEnd: 2026,
    sessionName: '2026', sessionTitle: '2026', sessionTag: '', prefile: 0, sineDie: 0, prior: 0, special: 0,
  })
  await db.insert(schema.bills).values({
    billId: 1, sessionId: 1, state: 'RI', stateId: 0, billNumber: 'H 1', title: 'Voter ID Act', changeHash: 'h', status: 1,
  })
  await db.insert(schema.billTenants).values({ billId: 1, tenantId, matchType: null })
  await db.insert(schema.keywordRegistry).values({ tenantId, keyword: 'voter' })
  return tenantId
}

function ingestorEnv() {
  const sendBatch = vi.fn().mockResolvedValue(undefined)
  const send = vi.fn().mockResolvedValue(undefined)
  return { e: { ...(env as any), ADMIN_SECRET: 'test-secret', INGESTOR_QUEUE: { sendBatch, send } }, sendBatch, send }
}

const bodies = (sendBatch: ReturnType<typeof vi.fn>) => sendBatch.mock.calls.flatMap(c => c[0].map((m: any) => m.body))

beforeEach(async () => {
  await clearDb()
  vi.clearAllMocks()
})

describe('bulk paths declare their keyword matches bulk', () => {
  it('a session seed declares its matches bulk', async () => {
    const tenantId = await seed()
    const { e, sendBatch } = ingestorEnv()

    const res = await app.request(`/api/tenants/seed-session/${tenantId}?sessionId=1`, { method: 'POST', headers: AUTH }, e)

    expect(res.status).toBe(200)
    expect(bodies(sendBatch)).toEqual([expect.objectContaining({ billId: 1, matchProvenance: { [tenantId]: 'bulk' } })])
  })

  it('a keyword re-run declares its matches bulk', async () => {
    const tenantId = await seed()
    const { e, sendBatch } = ingestorEnv()

    const res = await app.request(`/api/admin/sync-keywords/${tenantId}`, { method: 'POST', headers: AUTH }, e)

    expect(res.status).toBe(200)
    expect(bodies(sendBatch)).toEqual([expect.objectContaining({ billId: 1, matchProvenance: { [tenantId]: 'bulk' } })])
  })

  it('the match-type backfill sends nothing, so its matches reach instances undeclared, which is bulk', async () => {
    await seed()
    const { e, sendBatch, send } = ingestorEnv()

    const res = await app.request('/api/admin/backfill-match-types', { method: 'POST', headers: AUTH }, e)

    expect(res.status).toBe(200)
    expect(sendBatch).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })
})
