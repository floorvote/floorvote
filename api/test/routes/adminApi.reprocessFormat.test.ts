import { describe, it, expect, vi, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { app } from '../../src/index'
import { resetDb, applyMigrations, seedUser, seedSession } from '../helpers'
import { getDb } from '../../src/db/client'
import { bills } from '../../src/db/schema'

async function seedMatchedBill(externalId: string, textR2Key: string) {
  const db = getDb(env.DB)
  await db.insert(bills).values({
    id: crypto.randomUUID(),
    externalId,
    billNumber: 'SB 1',
    title: 'Matched Bill',
    state: 'CA',
    session: '2026 Regular Session',
    sessionId: 'ca:2026',
    tags: JSON.stringify([]),
    matchType: 'keyword',
    isDraft: false,
    textR2Key,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as typeof bills.$inferInsert)
}

describe('POST /admin/reprocess-llm-all?format=html', () => {
  let adminCookie: string
  let sendBatch: ReturnType<typeof vi.fn>
  let testEnv: typeof env

  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    const adminId = await seedUser({ role: 'admin' })
    adminCookie = `session=${await seedSession(adminId)}`

    await seedMatchedBill('legiscan:1', 'bills/ca/1.html')
    await seedMatchedBill('legiscan:2', 'bills/ca/2.pdf')

    sendBatch = vi.fn().mockResolvedValue(undefined)
    testEnv = { ...env, BILL_QUEUE: { sendBatch } } as unknown as typeof env
  })

  it('queues only html-sourced bills when format=html', async () => {
    const res = await app.request('/api/admin/reprocess-llm-all?format=html', {
      method: 'POST', headers: { Cookie: adminCookie },
    }, testEnv)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ queued: 1, format: 'html' })
    const sent = sendBatch.mock.calls.flat(2).map((m: { body: { billId: string } }) => m.body.billId)
    expect(sent).toEqual(['legiscan:1'])
  })

  it('queues every matched bill when format is omitted', async () => {
    const res = await app.request('/api/admin/reprocess-llm-all', {
      method: 'POST', headers: { Cookie: adminCookie },
    }, testEnv)
    expect(await res.json()).toMatchObject({ queued: 2 })
  })

  it('rejects an unrecognised format value without queueing anything', async () => {
    const res = await app.request('/api/admin/reprocess-llm-all?format=banana', {
      method: 'POST', headers: { Cookie: adminCookie },
    }, testEnv)
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: "unknown format; expected 'html'" })
    // A typo must not reprocess the PDF bills the filter exists to protect, so
    // assert on the queue too — a 400 sent *after* queueing still fails here.
    expect(sendBatch).not.toHaveBeenCalled()
  })
})
