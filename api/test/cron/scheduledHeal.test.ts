import { describe, it, expect, vi, beforeEach } from 'vitest'
import { env, createExecutionContext, createScheduledController, waitOnExecutionContext } from 'cloudflare:test'

vi.mock('../../src/lib/healStalledAi', () => ({
  healStalledAiBills: vi.fn(async () => ({ queued: 3, cappedOut: 0, remaining: 0 })),
  HEAL_MAX_ATTEMPTS: 5,
}))
vi.mock('../../src/cron/sync', () => ({ registerWithCentral: vi.fn(async () => true) }))

import worker from '../../src/index'
import { healStalledAiBills } from '../../src/lib/healStalledAi'
import { registerWithCentral } from '../../src/cron/sync'

async function runScheduled(cron: string) {
  const ctx = createExecutionContext()
  const controller = createScheduledController({ cron })
  await worker.scheduled(controller as unknown as ScheduledEvent, env as any, ctx)
  await waitOnExecutionContext(ctx)
}

describe('scheduled() heal branch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('runs the heal on the hourly cron and does not re-register', async () => {
    await runScheduled('0 * * * *')
    expect(healStalledAiBills).toHaveBeenCalledOnce()
    expect(registerWithCentral).not.toHaveBeenCalled()
  })

  it('does not run the heal on the daily cron', async () => {
    await runScheduled('0 11 * * *')
    expect(healStalledAiBills).not.toHaveBeenCalled()
  })

  it('does not run the heal on any other (fall-through) cron', async () => {
    await runScheduled('*/5 * * * *')
    expect(healStalledAiBills).not.toHaveBeenCalled()
    expect(registerWithCentral).toHaveBeenCalledOnce()
  })
})
