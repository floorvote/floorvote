import { env } from 'cloudflare:test'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { drizzle } from 'drizzle-orm/d1'
import { eq } from 'drizzle-orm'
import * as schema from '../../src/db/schema'
import { app } from '../../src/index'
import { runSync } from '../../src/cron/sync'
import * as legiscan from '../../src/providers/legiscan/client'
import { clearDb } from '../helpers/migrations'
import { BILL_KEYWORD_MATCH_CASES, type BillKeywordMatchCase } from '../../../shared/keywordMatchFixtures'

vi.mock('../../src/providers/legiscan/client', async () => {
  const actual = await vi.importActual<typeof import('../../src/providers/legiscan/client')>('../../src/providers/legiscan/client')
  return {
    ...actual,
    getMasterListBySession: vi.fn(),
    getMasterListRaw: vi.fn(),
    getSessionList: vi.fn().mockResolvedValue([]),
  }
})

vi.mock('../../src/lib/queuesRest', () => ({
  publishBatch: vi.fn().mockResolvedValue(undefined),
  publishMessage: vi.fn().mockResolvedValue(undefined),
  queuesRestEnabled: () => true,
}))

// The same fixtures the instance's tests run (api/test/routes/keywordMatchText.test.ts):
// each row is a bill and a keyword list, and every central match path must agree
// with the row's `expected`. An empty list is skipped where central returns early
// before matching anything.
const WITH_KEYWORDS = BILL_KEYWORD_MATCH_CASES.filter(c => c.keywords.length > 0)

const AUTH = { 'x-admin-secret': 'test-secret', 'content-type': 'application/json' }

let tenantSeq = 0

// One tenant per call: sync-keywords has a 60-second per-tenant cooldown.
async function seedBill({ bill, keywords }: BillKeywordMatchCase, matchType: 'keyword' | null = null) {
  const db = drizzle(env.DB, { schema })
  const tenantId = `match-text-${++tenantSeq}`
  await db.insert(schema.tenants).values({ tenantId, name: tenantId, active: true, stateCoverage: '["RI"]' })
  await db.insert(schema.sessions).values({
    sessionId: 1, state: 'RI', stateId: 0, yearStart: 2026, yearEnd: 2026,
    sessionName: '2026', sessionTitle: '2026', sessionTag: '', prefile: 0, sineDie: 0, prior: 0, special: 0,
  })
  await db.insert(schema.bills).values({
    billId: 1, sessionId: 1, state: 'RI', stateId: 0,
    billNumber: bill.billNumber, title: bill.title, description: bill.description,
    changeHash: 'hash', status: 1,
  })
  await db.insert(schema.billTenants).values({ billId: 1, tenantId, matchType })
  await db.insert(schema.keywordRegistry).values(keywords.map(keyword => ({ tenantId, keyword })))
  return { db, tenantId }
}

function ingestorEnv() {
  const sendBatch = vi.fn().mockResolvedValue(undefined)
  return { env2: { ...(env as any), INGESTOR_QUEUE: { sendBatch, send: vi.fn() } }, sendBatch }
}

beforeEach(async () => {
  await clearDb()
  vi.clearAllMocks()
  vi.mocked(legiscan.getSessionList).mockResolvedValue([])
})

describe('central keyword matching reads title + description + bill number', () => {
  describe('POST /tenants/seed-session/:tenantId', () => {
    it.each(WITH_KEYWORDS)('$name', async (c) => {
      const { tenantId } = await seedBill(c)
      const res = await app.request(
        `/api/tenants/seed-session/${tenantId}?sessionId=1&skipQueue=true`,
        { method: 'POST', headers: AUTH },
        { ...env, ADMIN_SECRET: 'test-secret' },
      )
      expect(res.status).toBe(200)
      expect(await res.json()).toMatchObject({ keywordMatches: c.expected ? 1 : 0 })
    })
  })

  describe('POST /admin/sync-keywords/:tenantId', () => {
    it.each(WITH_KEYWORDS)('$name', async (c) => {
      const { db, tenantId } = await seedBill(c)
      const { env2, sendBatch } = ingestorEnv()
      const res = await app.request(`/api/admin/sync-keywords/${tenantId}`, { method: 'POST', headers: AUTH }, env2)
      expect(res.status).toBe(200)
      expect(await res.json()).toMatchObject({ newlyMatched: c.expected ? 1 : 0 })
      const link = await db.select().from(schema.billTenants).where(eq(schema.billTenants.tenantId, tenantId)).get()
      expect(link?.matchType).toBe(c.expected ? 'keyword' : null)
      expect(sendBatch).toHaveBeenCalledTimes(c.expected ? 1 : 0)
    })
  })

  describe('POST /admin/backfill-match-types', () => {
    it.each(WITH_KEYWORDS)('$name', async (c) => {
      const { db, tenantId } = await seedBill(c)
      const res = await app.request('/api/admin/backfill-match-types', { method: 'POST', headers: AUTH }, env)
      expect(res.status).toBe(200)
      const link = await db.select().from(schema.billTenants).where(eq(schema.billTenants.tenantId, tenantId)).get()
      expect(link?.matchType).toBe(c.expected ? 'keyword' : null)
    })
  })

  describe('cron full pass', () => {
    it.each(WITH_KEYWORDS)('$name', async ({ bill, keywords, expected }) => {
      const db = drizzle(env.DB, { schema })
      const etHour = parseInt(
        new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', hourCycle: 'h23' }).format(new Date()),
        10,
      )
      await db.insert(schema.sessions).values({
        sessionId: 9001, state: 'DC', stateId: 51, yearStart: 2025, yearEnd: 2026,
        sessionTitle: 'Test', sessionName: 'Test',
        fullSyncHoursEt: JSON.stringify([etHour]), rawSyncHoursEt: JSON.stringify([]),
      })
      await db.insert(schema.tenants).values({
        tenantId: 'cron-t', name: 'Cron', stateCoverage: JSON.stringify(['DC']), active: true,
      })
      await db.insert(schema.keywordRegistry).values(keywords.map(keyword => ({ tenantId: 'cron-t', keyword })))
      vi.mocked(legiscan.getMasterListBySession).mockResolvedValue([{
        bill_id: 1, number: bill.billNumber, change_hash: 'h1', title: bill.title,
        description: bill.description, status: 1, status_date: '2025-01-01',
        last_action: 'introduced', last_action_date: '2025-01-01', url: 'https://example.com/1',
      }] as any)

      const { env2 } = ingestorEnv()
      await runSync(env2, db)

      const link = await db.select().from(schema.billTenants).where(eq(schema.billTenants.billId, 1)).get()
      expect(link?.matchType).toBe(expected ? 'keyword' : null)
    })
  })
})
