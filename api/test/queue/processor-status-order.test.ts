import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { env } from 'cloudflare:test'
import { eq } from 'drizzle-orm'
import { resetDb, applyMigrations, seedBill } from '../helpers'
import { getDb } from '../../src/db/client'
import { processCentralNotification } from '../../src/queue/processor'
import { bills } from '../../src/db/schema'
import type { TenantQueueMessage } from '../../src/types'

const BILL_ID = 'legiscan:3000000001'

function centralBill(extra: Record<string, unknown> = {}) {
  return {
    billId: BILL_ID, sessionId: '3000000000', sessionName: '2025-2026 Council Period 26', state: 'DC',
    number: 'B26-0400', title: 'Statutory Neglect Amendment Act of 2025', abstract: null,
    status: 'Under Mayoral Review', statusDate: '2026-05-01', updatedAt: '2026-05-21T00:00:00Z',
    stateUrl: null, textHash: null, textR2Key: null, texts: [], actions: [], sponsors: [], votes: [], relatedBills: [],
    ...extra,
  }
}

const testEnv = { ...env, TENANT_ID: 'test-tenant', CENTRAL_API_URL: 'https://central.test' }

async function notify(payload: object, flags: Partial<TenantQueueMessage>) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => payload }))
  const db = getDb(env.DB)
  await processCentralNotification({ tenantId: 'test-tenant', billId: BILL_ID, ...flags }, testEnv as any, db)
  return db.select({ status: bills.status, statusStage: bills.statusStage, statusRank: bills.statusRank })
    .from(bills).where(eq(bills.externalId, BILL_ID)).get()
}

describe('the status stage and rank central sends', () => {
  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('are stored with the label on a stub', async () => {
    expect(await notify(centralBill({ statusStage: 'passed', statusRank: 401 }), { stubOnly: true }))
      .toEqual({ status: 'Under Mayoral Review', statusStage: 'passed', statusRank: 401 })
  })

  it('replace the old ones on a metadata refresh', async () => {
    await seedBill({ externalId: BILL_ID, state: 'DC', status: 'Under Council Review', statusStage: 'in_committee', statusRank: 201 })
    expect(await notify(centralBill({ statusStage: 'passed', statusRank: 401 }), { metadataOnly: true }))
      .toEqual({ status: 'Under Mayoral Review', statusStage: 'passed', statusRank: 401 })
  })

  it('clear the stage of a status central has no vocabulary entry for', async () => {
    await seedBill({ externalId: BILL_ID, state: 'DC', status: 'Under Council Review', statusStage: 'in_committee', statusRank: 201 })
    expect(await notify(centralBill({ status: '999', statusStage: null, statusRank: 0 }), { metadataOnly: true }))
      .toEqual({ status: '999', statusStage: null, statusRank: 0 })
  })

  it('come from the status label when a central from before vocabularies sends neither', async () => {
    await seedBill({ externalId: BILL_ID, state: 'DC', status: 'Under Council Review', statusStage: 'in_committee', statusRank: 201 })
    expect(await notify(centralBill(), { metadataOnly: true }))
      .toEqual({ status: 'Under Mayoral Review', statusStage: 'passed', statusRank: 401 })
  })

  it('store a bare LegiScan code from such a central as the word central sends now', async () => {
    expect(await notify(centralBill({ state: 'RI', status: '7' }), { stubOnly: true }))
      .toEqual({ status: 'Override', statusStage: 'enacted', statusRank: 702 })
  })

  it('reach a tracked bill on a stub refresh, which otherwise leaves it alone', async () => {
    // A bill analyzed in the past and no longer matched gets only stubOnly
    // messages, so a one-time resend reaches it through refresh-stubs alone.
    await seedBill({
      externalId: BILL_ID, state: 'DC', status: 'Under Council Review', statusStage: 'in_committee', statusRank: 201,
      title: 'Kept title', aiProcessedAt: '2026-01-01 00:00:00', matchType: null,
    })
    expect(await notify(centralBill({ statusStage: 'passed', statusRank: 401 }), { stubOnly: true }))
      .toEqual({ status: 'Under Mayoral Review', statusStage: 'passed', statusRank: 401 })
    const row = await getDb(env.DB).select({ title: bills.title }).from(bills).where(eq(bills.externalId, BILL_ID)).get()
    expect(row?.title).toBe('Kept title')
  })
})
