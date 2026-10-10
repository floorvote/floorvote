import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { env } from 'cloudflare:test'
import { eq } from 'drizzle-orm'
import { resetDb, applyMigrations, seedBill } from '../helpers'
import { getDb } from '../../src/db/client'
import { processCentralNotification } from '../../src/queue/processor'
import { bills } from '../../src/db/schema'
import type { TenantQueueMessage } from '../../src/types'

// A history entry's meeting video (#294: DC's Council publishes hearing,
// mark-up, and reading videos), from central's bill to the history the bill
// page reads.
const BILL_ID = 'legiscan:1012600400'
const HEARING_VIDEO = 'http://video.oct.dc.gov/VOD/DCC/2025_11/11_13_25_Youth_Judici.html'

function centralBill(actions: object[]) {
  return {
    billId: BILL_ID, sessionId: '1000000026', sessionName: '2025-2026 Council Period 26', state: 'DC',
    number: 'B26-0400', title: 'Statutory Neglect Amendment Act of 2025', abstract: null,
    status: 'Official Law', statusStage: 'enacted', statusRank: 705, statusDate: '2026-06-26', updatedAt: '2026-06-26T00:00:00Z',
    stateUrl: null, textHash: null, textR2Key: null, texts: [], actions, sponsors: [], votes: [], relatedBills: [],
  }
}

const action = (date: string, description: string, videoUrl?: string | null) =>
  ({ date, description, chamber: 'C', classification: [], order: 0, ...(videoUrl === undefined ? {} : { videoUrl }) })

const testEnv = { ...env, TENANT_ID: 'test-tenant', CENTRAL_API_URL: 'https://central.test' }

async function history(actions: object[], flags: Partial<TenantQueueMessage>) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => centralBill(actions) }))
  const db = getDb(env.DB)
  await processCentralNotification({ tenantId: 'test-tenant', billId: BILL_ID, ...flags }, testEnv as any, db)
  const row = await db.select({ history: bills.history }).from(bills).where(eq(bills.externalId, BILL_ID)).get()
  return JSON.parse(row!.history!)
}

describe('a meeting video on a history entry', () => {
  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('is stored with the entry it records', async () => {
    expect(await history([
      action('2025-10-06', 'B26-0400 Introduced', null),
      action('2025-11-13', 'Public Hearing on B26-0400', HEARING_VIDEO),
    ], { stubOnly: true })).toEqual([
      { date: '2025-10-06', action: 'B26-0400 Introduced', chamber: 'C' },
      { date: '2025-11-13', action: 'Public Hearing on B26-0400', chamber: 'C', videoUrl: HEARING_VIDEO },
    ])
  })

  it('reaches a stored bill on a metadata refresh', async () => {
    await seedBill({ externalId: BILL_ID, state: 'DC' })
    const stored = await history([action('2025-11-13', 'Public Hearing on B26-0400', HEARING_VIDEO)], { metadataOnly: true })
    expect(stored[0].videoUrl).toBe(HEARING_VIDEO)
  })

  it('is dropped unless it is an http(s) link', async () => {
    const stored = await history([
      action('2025-11-13', 'Public Hearing on B26-0400', 'javascript:alert(1)'),
      action('2026-01-27', 'Committee Mark-up of B26-0400', '/VOD/relative.html'),
    ], { stubOnly: true })
    expect(stored.map((h: { videoUrl?: string }) => h.videoUrl)).toEqual([undefined, undefined])
  })

  it('is absent when central sends none, as an older central doesn\'t', async () => {
    const stored = await history([action('2025-11-13', 'Public Hearing on B26-0400')], { stubOnly: true })
    expect(stored).toEqual([{ date: '2025-11-13', action: 'Public Hearing on B26-0400', chamber: 'C' }])
  })
})
