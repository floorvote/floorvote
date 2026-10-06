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
vi.mock('../../src/lib/emailHealthJob', () => ({ runEmailHealth: vi.fn(async () => 'none') }))
vi.mock('../../src/lib/inviteBounceJob', () => ({ runInviteBounceCheck: vi.fn(async () => []) }))

import worker from '../../src/index'
import { healStalledAiBills } from '../../src/lib/healStalledAi'
import { registerWithCentral } from '../../src/cron/sync'
import { runEmailHealth } from '../../src/lib/emailHealthJob'
import { runInviteBounceCheck } from '../../src/lib/inviteBounceJob'

async function runScheduled(cron: string, scheduledTime?: number) {
  const ctx = createExecutionContext()
  const controller = createScheduledController({ cron, scheduledTime })
  await worker.scheduled(controller as unknown as ScheduledEvent, env as any, ctx)
  await waitOnExecutionContext(ctx)
}

describe('scheduled() heal branch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('runs the email-health check on the hourly cron only', async () => {
    await runScheduled('0 * * * *')
    expect(runEmailHealth).toHaveBeenCalledOnce()
    vi.clearAllMocks()
    await runScheduled('0 11 * * *')
    expect(runEmailHealth).not.toHaveBeenCalled()
  })

  it('passes the scheduled time, not the wall clock, to the email-health check', async () => {
    const scheduledTime = Date.parse('2026-09-30T12:00:00Z')
    await runScheduled('0 * * * *', scheduledTime)
    expect(vi.mocked(runEmailHealth).mock.calls[0][2]).toEqual(new Date(scheduledTime))
  })

  it('runs the invite bounce check on the hourly cron only, with the scheduled time', async () => {
    const scheduledTime = Date.parse('2026-09-30T12:00:00Z')
    await runScheduled('0 * * * *', scheduledTime)
    expect(runInviteBounceCheck).toHaveBeenCalledOnce()
    expect(vi.mocked(runInviteBounceCheck).mock.calls[0][2]).toEqual(new Date(scheduledTime))
    vi.clearAllMocks()
    await runScheduled('0 11 * * *')
    await runScheduled('*/5 * * * *')
    expect(runInviteBounceCheck).not.toHaveBeenCalled()
  })

  it('does not alert when the invite bounce check rejects, and the other hourly jobs still run', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const inner = new Error('D1_ERROR: database is locked')
    vi.mocked(runInviteBounceCheck).mockRejectedValueOnce(new Error('Failed query: select ...', { cause: inner }))

    await runScheduled('0 * * * *')

    expect(sendEmail).not.toHaveBeenCalled()
    expect(runEmailHealth).toHaveBeenCalledOnce()
    expect(healStalledAiBills).toHaveBeenCalledOnce()
    const logged = error.mock.calls.map((c) => c.join(' ')).join('\n')
    expect(logged).toContain('[invite-bounces] check failed, skipping this run')
    expect(logged).toContain('database is locked')
    error.mockRestore()
  })

  it('does not alert when email-health rejects, and the heal still runs', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const inner = new Error('D1_ERROR: no such table: email_send_stats')
    vi.mocked(runEmailHealth).mockRejectedValueOnce(new Error('Failed query: select ...', { cause: inner }))

    await runScheduled('0 * * * *')

    expect(sendEmail).not.toHaveBeenCalled()
    expect(healStalledAiBills).toHaveBeenCalledOnce()
    const logged = error.mock.calls.map((c) => c.join(' ')).join('\n')
    expect(logged).toContain('[email-health] check failed, skipping this run')
    expect(logged).toContain('no such table')
    error.mockRestore()
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
