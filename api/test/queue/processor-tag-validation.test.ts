import { describe, it, expect, vi, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { eq } from 'drizzle-orm'
import { resetDb, applyMigrations } from '../helpers'
import { getDb } from '../../src/db/client'
import { processCentralNotification } from '../../src/queue/processor'
import { bills, associationConfig } from '../../src/db/schema'
import type { TenantQueueMessage } from '../../src/types'

vi.mock('../../src/lib/llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/llm')>()
  return {
    ...actual,
    // 'Provisional Voting' is NOT in the taxonomy the test seeds below.
    processBill: vi.fn().mockResolvedValue({
      summary: 'AI summary', tags: ['Elections', 'Provisional Voting'], relevanceScore: 5,
    }),
  }
})

const BILL_ID = 'legiscan:tag-validation-1'
const centralBill = {
  billId: BILL_ID, sessionId: 'nj:2026', state: 'NJ', number: 'A1',
  title: 'An Act concerning elections', abstract: 'Concerns election administration.',
  status: 'introduced', statusDate: '2026-01-01', updatedAt: '2026-01-10T12:00:00Z',
  openstatesUrl: null, stateUrl: 'https://njleg.gov/A1',
  textHash: 'hash-v1', textR2Key: 'bills/a1/v1.html',
  texts: [{ docId: 'doc-1', note: 'Introduced', date: '2026-01-01', links: [{ url: 'https://njleg.gov/A1.html', mediaType: 'text/html' }] }],
  actions: [{ description: 'Introduced', date: '2026-01-01', chamber: 'lower', classification: ['introduction'], order: 1 }],
  sponsors: [{ name: 'Rep A', party: 'D', role: 'Assembly', primary: true, personId: 'p1' }],
  votes: [], relatedBills: [],
}
const testEnv = { ...env, TENANT_ID: 'test-org', CENTRAL_API_URL: 'https://central.test', INSTANCE_PRESET: 'election_officials' }

describe('processor — write-time tag validation', () => {
  beforeEach(async () => { await resetDb(); await applyMigrations(); vi.clearAllMocks() })

  it('drops AI tags not in the tenant taxonomy before storing', async () => {
    const db = getDb(env.DB)
    // Seed instance_preset too: ensureInstancePreset() bootstraps a fresh tenant (no
    // instance_preset row) by overwriting tag_taxonomy with the preset default, which would
    // clobber the taxonomy seeded below before this test's AI/store step ever reads it.
    await db.insert(associationConfig).values({ key: 'instance_preset', value: JSON.stringify('election_officials') })
    await db.insert(associationConfig).values({ key: 'tag_taxonomy', value: JSON.stringify([{ name: 'Elections' }]) })
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) =>
      url.includes('/text')
        ? Promise.resolve({ ok: true, json: async () => ({ type: 'html', content: '<p>text</p>' }) })
        : Promise.resolve({ ok: true, json: async () => centralBill }),
    ))
    const msg: TenantQueueMessage = { tenantId: 'test-org', billId: BILL_ID, matchType: 'keyword', forceAI: true }
    await processCentralNotification(msg, testEnv as any, db)

    const row = await db.select({ tags: bills.tags }).from(bills).where(eq(bills.externalId, BILL_ID)).get()
    expect(JSON.parse(row!.tags)).toEqual(['Elections']) // 'Provisional Voting' dropped
  })
})
