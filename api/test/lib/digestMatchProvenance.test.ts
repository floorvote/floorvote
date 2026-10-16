import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { env } from 'cloudflare:test'
import { resetDb, applyMigrations, seedUser, seedSession, seedBill } from '../helpers'
import { getDb } from '../../src/db/client'
import { associationConfig } from '../../src/db/schema'
import { processCentralNotification } from '../../src/queue/processor'
import { runDigest } from '../../src/lib/digest'
import type { TenantQueueMessage } from '../../src/types'

// Seam 1 of #363: what the digest's new-match section lists, for matches that
// reached the instance from central with each kind of declaration. Only a
// routine match is listed; a seed's, a keyword re-run's, and an undeclared
// (pre-upgrade) match stay out.

vi.mock('../../src/lib/llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/llm')>()
  return {
    ...actual,
    processBill: vi.fn().mockResolvedValue({ summary: 'Summary', tags: [], relevanceScore: 8, affectedCitations: [] }),
  }
})

const centralBill = (n: number) => ({
  billId: `legiscan:${n}`,
  sessionId: 'ri:2026', sessionName: '2026', state: 'RI', number: `HB ${n}`,
  title: `Election Act ${n}`, abstract: 'An act relating to elections', status: 'introduced',
  statusDate: '2026-01-01', updatedAt: '2026-01-10T12:00:00Z', stateUrl: null,
  textHash: `hash-${n}`, textR2Key: `bills/${n}.html`,
  texts: [{ docId: `doc-${n}`, note: 'Introduced', date: '2026-01-01', links: [] }],
  actions: [], sponsors: [], votes: [], relatedBills: [],
})

const tenantEnv = { ...env, TENANT_ID: 'test-org', CENTRAL_API_URL: 'https://central.test' }

let emails: any[]

beforeEach(async () => {
  await resetDb(); await applyMigrations()
  emails = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => {
    const u = String(url)
    if (u.startsWith('https://central.test/api/bills/')) {
      const n = Number(u.split('legiscan:')[1].split('/')[0])
      if (u.endsWith('/text')) return new Response(JSON.stringify({ type: 'html', content: '<p>text</p>' }))
      return new Response(JSON.stringify(centralBill(n)))
    }
    emails.push(JSON.parse(init.body))
    return new Response('{}', { status: 200 })
  }))
  const db = getDb(env.DB)
  await db.insert(associationConfig).values([
    { key: 'modules', value: JSON.stringify({ 'email-digest': true }) },
    { key: 'keywords', value: JSON.stringify(['election']) },
  ])
  const admin = await seedUser({ email: 'admin@e.com', role: 'admin' }); await seedSession(admin)
})
afterEach(() => { vi.unstubAllGlobals() })

async function arrive(n: number, extra: Partial<TenantQueueMessage>) {
  await processCentralNotification({ tenantId: 'test-org', billId: `legiscan:${n}`, matchType: 'keyword', ...extra }, tenantEnv as any, getDb(env.DB))
}

describe('the digest lists only routine new matches', () => {
  it('lists a routine new bill', async () => {
    await arrive(1, { matchProvenance: 'routine' })

    await runDigest(env as any, getDb(env.DB))

    expect(emails).toHaveLength(1)
    expect(emails[0].html).toContain('New matches (1)')
    expect(emails[0].html).toContain('HB 1')
  })

  it("leaves a session seed's matches out", async () => {
    // seed-session sends keyword bills through the ingestor with skipFetch + forceMetadata.
    await arrive(2, { forceMetadata: true, matchProvenance: 'bulk' })
    await arrive(3, { forceMetadata: true, matchProvenance: 'bulk' })

    await runDigest(env as any, getDb(env.DB))

    expect(emails).toHaveLength(0)
  })

  it("leaves a keyword re-run's matches out", async () => {
    // sync-keywords sends each newly matched bill with forceAI.
    await arrive(4, { forceAI: true, matchProvenance: 'bulk' })

    await runDigest(env as any, getDb(env.DB))

    expect(emails).toHaveLength(0)
  })

  it('leaves a match with no declaration out', async () => {
    await arrive(5, {})

    await runDigest(env as any, getDb(env.DB))

    expect(emails).toHaveLength(0)
  })

  it('lists the routine match beside bulk ones, counting only the routine', async () => {
    await arrive(6, { matchProvenance: 'routine' })
    await arrive(7, { forceMetadata: true, matchProvenance: 'bulk' })

    await runDigest(env as any, getDb(env.DB))

    expect(emails).toHaveLength(1)
    expect(emails[0].html).toContain('New matches (1)')
    expect(emails[0].html).toContain('HB 6')
    expect(emails[0].html).not.toContain('HB 7')
  })

  it('applies the minimum relevance for new matches to routine matches', async () => {
    const db = getDb(env.DB)
    await db.insert(associationConfig).values({ key: 'new_match_min_relevance', value: '6' })
    const recent = new Date(Date.now() - 3600_000).toISOString().slice(0, 19).replace('T', ' ')
    await seedBill({ billNumber: 'HI 1', matchType: 'keyword', newMatchAt: recent, relevanceScore: 6, matchProvenance: 'routine' })
    await seedBill({ billNumber: 'LO 1', matchType: 'keyword', newMatchAt: recent, relevanceScore: 5, matchProvenance: 'routine' })

    await runDigest(env as any, db)

    expect(emails).toHaveLength(1)
    expect(emails[0].html).toContain('New matches (1)')
    expect(emails[0].html).toContain('HI 1')
    expect(emails[0].html).not.toContain('LO 1')
  })
})
