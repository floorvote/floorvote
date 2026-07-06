import { env, applyD1Migrations, reset } from 'cloudflare:test'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { drizzle } from 'drizzle-orm/d1'
import { eq } from 'drizzle-orm'
import * as schema from '../../src/db/schema'
import { processSingleBill } from '../../src/queue/processor'
import migration0001 from '../../migrations/0001_initial.sql?raw'
import migration0003 from '../../migrations/0003_openstates_migration.sql?raw'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

function parseMigration(sql: string, name: string) {
  const queries = sql
    .split(';')
    .map((s) =>
      s.split('\n').filter((line) => !line.trimStart().startsWith('--')).join('\n').trim(),
    )
    .filter((s) => s.length > 0)
    .map((s) => s + ';')
  return { name, queries }
}

const fakeBill = {
  id: 'ocd-bill/abc123',
  state: 'NJ',
  session: '222',
  number: 'A1',
  title: 'Election Law Reform Act',
  abstract: 'Reforms election law',
  status: 'introduced' as const,
  statusDate: '2026-01-01',
  lastAction: 'Introduced',
  lastActionDate: '2026-01-01',
  url: 'https://openstates.org/nj/bills/222/A1/',
  stateUrl: 'https://njleg.state.nj.us/A1',
  sponsors: [],
  versions: [
    {
      id: 'ver-50',
      note: 'Introduced',
      date: '2026-01-01',
      links: [{ url: 'https://njleg.state.nj.us/A1/text.html', mediaType: 'text/html' }],
    },
  ],
  actions: [{ description: 'Introduced', date: '2026-01-01', chamber: 'lower', classification: ['introduction'], order: 1 }],
  documents: [],
  votes: [],
  relatedBills: [],
  updatedAt: '2026-01-15T00:00:00Z',
}

beforeEach(async () => {
  mockFetch.mockReset()
  await reset()
  await applyD1Migrations(env.DB, [
    parseMigration(migration0001, '0001_initial'),
    parseMigration(migration0003, '0003_openstates_migration'),
  ])
})

describe('processSingleBill', () => {
  it('fetches bill detail, stores text in R2, updates DB, notifies tenant', async () => {
    const db = drizzle(env.DB, { schema })

    await db.insert(schema.sessions).values({
      sessionId: 'nj:222', state: 'NJ', identifier: '222',
      yearStart: 2026, yearEnd: 2027, sessionName: '2026 Session',
      isCurrent: true, sineDie: false,
    })
    await db.insert(schema.bills).values({
      billId: 'ocd-bill/abc123', sessionId: 'nj:222', state: 'NJ', number: 'A1',
      title: 'Election Law Reform Act',
    })
    await db.insert(schema.billTenants).values({
      billId: 'ocd-bill/abc123', tenantId: 'test-nj', matchedKeyword: 'election',
    })

    mockFetch.mockResolvedValueOnce(new Response('<p>Election law text</p>', {
      status: 200, headers: { 'Content-Type': 'text/html' },
    }))

    const sentMessages: unknown[] = []
    const mockProvider = {
      fetchBillDetail: vi.fn().mockResolvedValue(fakeBill),
    }
    const mockEnv = {
      ...env,
      TENANT_QUEUE_TEST_NJ: { send: async (msg: unknown) => { sentMessages.push(msg) } },
    } as any

    await processSingleBill({ billId: 'ocd-bill/abc123' }, mockEnv, db, mockProvider)

    const bill = await db.select().from(schema.bills).where(eq(schema.bills.billId, 'ocd-bill/abc123')).get()
    expect(bill?.providerData).toBeTruthy()
    expect(bill?.textR2Key).toContain('bills/abc123/')

    const obj = await env.BILLS_BUCKET.get(bill!.textR2Key!)
    expect(obj).toBeTruthy()
    const text = await obj!.text()
    expect(text).toBe('<p>Election law text</p>')

    expect(sentMessages).toHaveLength(1)
    expect(sentMessages[0]).toEqual({ tenantId: 'test-nj', billId: 'ocd-bill/abc123' })
  })

  it('skips re-fetching when updatedAt matches and text exists', async () => {
    const db = drizzle(env.DB, { schema })

    await db.insert(schema.sessions).values({
      sessionId: 'nj:222', state: 'NJ', identifier: '222',
      yearStart: 2026, yearEnd: 2027, sessionName: '2026 Session',
      isCurrent: true, sineDie: false,
    })
    await db.insert(schema.bills).values({
      billId: 'ocd-bill/abc123', sessionId: 'nj:222', state: 'NJ', number: 'A1',
      title: 'Election Law Reform Act', updatedAt: '2026-01-15T00:00:00Z',
      textR2Key: 'bills/abc123/ver-50.html', providerData: '{}',
    })
    await db.insert(schema.billTenants).values({
      billId: 'ocd-bill/abc123', tenantId: 'test-nj', matchedKeyword: 'election',
    })

    const mockProvider = {
      fetchBillDetail: vi.fn().mockResolvedValue(fakeBill),
    }
    const mockEnv = {
      ...env,
      TENANT_QUEUE_TEST_NJ: { send: async () => {} },
    } as any

    await processSingleBill({ billId: 'ocd-bill/abc123' }, mockEnv, db, mockProvider)

    // fetch should not be called for version text since updatedAt matches
    expect(mockFetch).not.toHaveBeenCalled()
  })
})
