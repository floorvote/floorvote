import { describe, it, expect, vi, beforeEach } from 'vitest'
import { env, createExecutionContext, createScheduledController, waitOnExecutionContext } from 'cloudflare:test'

vi.mock('../../src/lib/healStalledAi', () => ({
  healStalledAiBills: vi.fn(async () => ({ queued: 3, cappedOut: 0, remaining: 0 })),
  HEAL_MAX_ATTEMPTS: 5,
}))
vi.mock('../../src/cron/sync', () => ({ registerWithCentral: vi.fn(async () => true) }))
vi.mock('../../src/lib/digest', () => ({ runDigest: vi.fn(async () => undefined) }))
vi.mock('../../src/lib/weekAhead', () => ({ runWeekAhead: vi.fn(async () => undefined) }))
const sendEmail = vi.fn(async () => ({ ok: true, provider: 'resend' as const }))
vi.mock('../../src/lib/email', () => ({ sendEmail: (env: any, msg: any) => sendEmail(env, msg) }))

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

  // Nothing decrements ai_heal_attempts, so cappedOut is a standing condition,
  // not an event. Failing the job on it would email ALERT_EMAILS "cron failed:
  // heal-ai" every hour forever about a cron that ran fine.
  it('warns but does not fail the job when bills have capped out', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(healStalledAiBills).mockResolvedValueOnce({ queued: 0, cappedOut: 7, remaining: 7 })

    await runScheduled('0 * * * *')

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('7 bill(s) have hit the 5-attempt heal cap'))
    // runJob logs `[job:heal-ai] failed` and emails on a throw. Neither may happen.
    expect(error).not.toHaveBeenCalledWith(expect.stringContaining('[job:heal-ai] failed'), expect.anything())
    warn.mockRestore()
    error.mockRestore()
  })

  // A transient D1 read failure (the incident this branch exists to survive)
  // must not propagate to runJob's alert path. It should be logged, loudly,
  // with the real cause intact — not just Drizzle's "Failed query: ..." wrapper.
  it('does not alert when healStalledAiBills rejects, and logs the cause chain', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const inner = new Error('D1_ERROR: too many retries')
    const wrapped = new Error('Failed query: select count(*) from bills', { cause: inner })
    vi.mocked(healStalledAiBills).mockRejectedValueOnce(wrapped)

    await runScheduled('0 * * * *')

    // Neither runJob's own failure log nor the alert email may fire.
    expect(error).not.toHaveBeenCalledWith(expect.stringContaining('[job:heal-ai] failed'), expect.anything())
    expect(sendEmail).not.toHaveBeenCalled()

    const logged = error.mock.calls.map((c) => c.join(' ')).join('\n')
    expect(logged).toContain('[heal-ai]')
    expect(logged).toContain('D1_ERROR: too many retries')
    error.mockRestore()
  })
})
