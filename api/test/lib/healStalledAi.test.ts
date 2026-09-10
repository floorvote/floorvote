import { describe, it, expect, beforeEach, vi } from 'vitest'
import { env } from 'cloudflare:test'
import { applyMigrations, resetDb } from '../helpers'
import { getDb } from '../../src/db/client'
import { bills } from '../../src/db/schema'
import { healStalledAiBills, countStalledAiBills, countLongStalledAiBills } from '../../src/lib/healStalledAi'

const NOW = new Date('2026-09-09T12:00:00Z')

/** Space-separated UTC, `minutesAgo` before NOW — the nowDb() wire format. */
function ago(minutesAgo: number): string {
  return new Date(NOW.getTime() - minutesAgo * 60_000).toISOString().slice(0, 19).replace('T', ' ')
}

type BillOverrides = Partial<typeof bills.$inferInsert>

async function seedBill(id: string, overrides: BillOverrides = {}) {
  const db = getDb(env.DB)
  await db.insert(bills).values({
    id,
    externalId: `legiscan:${id}`,
    billNumber: `SB${id}`,
    title: `Bill ${id}`,
    state: 'NV',
    aiAttemptedAt: ago(120),
    aiProcessedAt: null,
    aiSkipReason: null,
    aiHealAttempts: 0,
    ...overrides,
  } as typeof bills.$inferInsert).run()
}

function fakeEnv(sent: unknown[]) {
  return {
    TENANT_ID: 'nvsos',
    BILL_QUEUE: { send: vi.fn(async (m: unknown) => { sent.push(m) }) },
  } as unknown as Parameters<typeof healStalledAiBills>[0]
}

describe('healStalledAiBills selection', () => {
  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
  })

  it('does not select a bill attempted 5 minutes ago', async () => {
    await seedBill('a', { aiAttemptedAt: ago(5) })
    const sent: unknown[] = []
    const res = await healStalledAiBills(fakeEnv(sent), getDb(env.DB), { now: NOW })
    expect(res.queued).toBe(0)
    expect(sent).toHaveLength(0)
  })

  it('selects a bill attempted 2 hours ago', async () => {
    await seedBill('b', { aiAttemptedAt: ago(120) })
    const sent: unknown[] = []
    const res = await healStalledAiBills(fakeEnv(sent), getDb(env.DB), { now: NOW })
    expect(res.queued).toBe(1)
    expect(sent[0]).toEqual({ tenantId: 'nvsos', billId: 'legiscan:b', forceAI: true })
  })

  it('does not select a bill with ai_skip_reason set', async () => {
    await seedBill('c', { aiSkipReason: 'pdf_too_large' })
    const res = await healStalledAiBills(fakeEnv([]), getDb(env.DB), { now: NOW })
    expect(res.queued).toBe(0)
  })

  it('does not select a bill at the attempt cap, and counts it as cappedOut', async () => {
    await seedBill('d', { aiHealAttempts: 5 })
    const res = await healStalledAiBills(fakeEnv([]), getDb(env.DB), { now: NOW })
    expect(res.queued).toBe(0)
    expect(res.cappedOut).toBe(1)
  })

  it('does not select a bill that has been processed', async () => {
    await seedBill('e', { aiProcessedAt: ago(60) })
    const res = await healStalledAiBills(fakeEnv([]), getDb(env.DB), { now: NOW })
    expect(res.queued).toBe(0)
  })

  it('increments ai_heal_attempts on the bills it queues', async () => {
    await seedBill('f')
    await healStalledAiBills(fakeEnv([]), getDb(env.DB), { now: NOW })
    const row = await getDb(env.DB).select().from(bills).get()
    expect(row!.aiHealAttempts).toBe(1)
  })

  it('respects the per-run limit and reports the remainder', async () => {
    await seedBill('g1'); await seedBill('g2'); await seedBill('g3')
    const sent: unknown[] = []
    const res = await healStalledAiBills(fakeEnv(sent), getDb(env.DB), { now: NOW, limit: 2 })
    expect(res.queued).toBe(2)
    expect(sent).toHaveLength(2)
    expect(res.remaining).toBe(1)
  })

  it('stops the run when the queue send throws, rather than burning the batch', async () => {
    await seedBill('q1', { aiAttemptedAt: ago(300) })  // oldest → always first
    await seedBill('q2', { aiAttemptedAt: ago(200) })
    await seedBill('q3', { aiAttemptedAt: ago(100) })
    const downQueue = {
      TENANT_ID: 'nvsos',
      BILL_QUEUE: { send: vi.fn(async () => { throw new Error('queue unavailable') }) },
    } as unknown as Parameters<typeof healStalledAiBills>[0]

    const res = await healStalledAiBills(downQueue, getDb(env.DB), { now: NOW })

    // One send attempted, then the run ends: the ordering is deterministic, so
    // pushing on would spend every eligible bill's attempt on a dead queue.
    expect(downQueue.BILL_QUEUE!.send).toHaveBeenCalledOnce()
    expect(res.queued).toBe(0)
    expect(res.remaining).toBe(3)
    const rows = await getDb(env.DB).select().from(bills).all()
    expect(rows.filter(r => r.aiHealAttempts > 0)).toHaveLength(1)
  })

  it('countStalledAiBills counts qualifying bills without queueing', async () => {
    await seedBill('h1'); await seedBill('h2', { aiSkipReason: 'pdf_too_large' })
    expect(await countStalledAiBills(getDb(env.DB), NOW)).toBe(1)
  })

  it('countLongStalledAiBills does not count a bill stalled only 2 hours', async () => {
    await seedBill('i1', { aiAttemptedAt: ago(120) })
    expect(await countLongStalledAiBills(getDb(env.DB), NOW)).toBe(0)
  })

  it('countLongStalledAiBills counts a bill stalled 30 hours', async () => {
    await seedBill('i2', { aiAttemptedAt: ago(30 * 60) })
    expect(await countLongStalledAiBills(getDb(env.DB), NOW)).toBe(1)
  })
})
