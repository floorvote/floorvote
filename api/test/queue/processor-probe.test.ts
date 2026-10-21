import { describe, it, expect, vi, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { clearDb } from '../helpers'
import { getDb } from '../../src/db/client'
import { processCentralNotification, processQueue } from '../../src/queue/processor'
import worker from '../../src/index'
import { readDeliveryProbe } from '../../src/lib/deliveryProbe'
import { bills, feedEvents, associationConfig } from '../../src/db/schema'
import type { TenantQueueMessage } from '../../src/types'

vi.mock('../../src/lib/llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/llm')>()
  return { ...actual, processBill: vi.fn().mockResolvedValue({ summary: 's', tags: [], relevanceScore: 5, affectedCitations: [] }) }
})

const testEnv = { ...env, TENANT_ID: 'test-org', CENTRAL_API_URL: 'https://central.test' } as any
const probe = (over: Partial<TenantQueueMessage> = {}): TenantQueueMessage =>
  ({ tenantId: 'test-org', billId: 'legiscan:42', probe: 'nonce-1', ...over })

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(async () => {
  await clearDb()
  vi.clearAllMocks()
  fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ billId: 'legiscan:42', title: 'A bill', number: 'HB 1' }), { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
})

describe('delivery probe message', () => {
  it('records that it arrived, and that the instance could read the bill from central', async () => {
    const db = getDb(env.DB)
    await processCentralNotification(probe(), testEnv, db)
    expect(await readDeliveryProbe(db)).toMatchObject({ nonce: 'nonce-1', billId: 'legiscan:42', readStatus: 200 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0][0])).toContain('/api/bills/legiscan:42')
  })

  // Release 2 of #305: a capable instance is probed with `bill:<n>`. It records
  // the handle as central sent it, and still reads the bill back by the legacy one.
  it.each(['bill:42', 'legiscan:42'])('records a %s probe under the handle central sent', async (handle) => {
    const db = getDb(env.DB)
    await processCentralNotification(probe({ billId: handle }), testEnv, db)
    expect(await readDeliveryProbe(db)).toMatchObject({ nonce: 'nonce-1', billId: handle, readStatus: 200 })
    expect(String(fetchMock.mock.calls[0][0])).toContain('/api/bills/legiscan:42')
  })

  it('does not track the bill, analyze it, or write a feed event', async () => {
    const db = getDb(env.DB)
    await db.insert(associationConfig).values({ key: 'keywords', value: JSON.stringify(['bill']) })
    await processCentralNotification(probe(), testEnv, db)
    expect(await db.select().from(bills).all()).toEqual([])
    expect(await db.select().from(feedEvents).all()).toEqual([])
    const { processBill } = await import('../../src/lib/llm')
    expect(processBill).not.toHaveBeenCalled()
    // Only the bill record is read: no text, no second fetch.
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('records the status when central refuses the read, rather than throwing and retrying', async () => {
    fetchMock.mockResolvedValue(new Response('forbidden', { status: 403 }))
    const db = getDb(env.DB)
    await processCentralNotification(probe(), testEnv, db)
    expect(await readDeliveryProbe(db)).toMatchObject({ nonce: 'nonce-1', readStatus: 403 })
  })

  it('records status 0 when the call to central fails outright', async () => {
    fetchMock.mockRejectedValue(new TypeError('network down'))
    const db = getDb(env.DB)
    await processCentralNotification(probe(), testEnv, db)
    expect(await readDeliveryProbe(db)).toMatchObject({ nonce: 'nonce-1', readStatus: 0 })
  })

  it('ignores a probe addressed to another instance', async () => {
    const db = getDb(env.DB)
    await processCentralNotification(probe({ probe: 'mine' }), testEnv, db)
    await processCentralNotification(probe({ tenantId: 'someone-else', probe: 'theirs' }), testEnv, db)
    expect((await readDeliveryProbe(db))?.nonce).toBe('mine')
  })

  it('keeps only the latest probe', async () => {
    const db = getDb(env.DB)
    await processCentralNotification(probe({ probe: 'first' }), testEnv, db)
    await processCentralNotification(probe({ probe: 'second' }), testEnv, db)
    expect((await readDeliveryProbe(db))?.nonce).toBe('second')
  })

  // A demo instance drops every bill message that does not force a refresh, so a
  // probe would vanish and the check would report a missing consumer.
  it('is recorded on a demo instance, which otherwise drops bill messages', async () => {
    const db = getDb(env.DB)
    const demoEnv = { ...testEnv, DEMO_MODE: 'true' }
    const ack = vi.fn()
    await worker.queue({ messages: [{ body: probe({ probe: 'demo-n' }), attempts: 1, ack, retry: vi.fn() }] } as any, demoEnv)
    expect((await readDeliveryProbe(db))?.nonce).toBe('demo-n')
    expect(ack).toHaveBeenCalledTimes(1)
  })

  // The freeze exists so a demo's bill set stays what its seed shipped. A probe
  // sharing a batch with ordinary notifications must not open it for them.
  it('does not unfreeze a demo instance for the ordinary notifications in its batch', async () => {
    const db = getDb(env.DB)
    const demoEnv = { ...testEnv, DEMO_MODE: 'true' }
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      billId: 'legiscan:7', sessionId: 's', state: 'RI', number: 'HB 7', title: 'Ordinary', abstract: null, status: 'introduced',
      updatedAt: '2026-01-10T12:00:00Z', textHash: null, texts: [], actions: [], sponsors: [], votes: [], relatedBills: [],
    }), { status: 200 }))
    const ordinary = { body: { tenantId: 'test-org', billId: 'legiscan:7' }, attempts: 1, ack: vi.fn(), retry: vi.fn() }
    const probing = { body: probe({ probe: 'mixed' }), attempts: 1, ack: vi.fn(), retry: vi.fn() }
    await worker.queue({ messages: [ordinary, probing] } as any, demoEnv)
    expect((await readDeliveryProbe(db))?.nonce).toBe('mixed')
    expect(await db.select().from(bills).all()).toEqual([])
  })

  it('is acknowledged by the queue consumer, not retried', async () => {
    const db = getDb(env.DB)
    const ack = vi.fn()
    const retry = vi.fn()
    await processQueue([{ body: probe(), attempts: 1, ack, retry } as any], testEnv, db)
    expect(ack).toHaveBeenCalledTimes(1)
    expect(retry).not.toHaveBeenCalled()
  })
})
