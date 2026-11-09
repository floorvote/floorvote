import { describe, it, expect, vi, beforeEach } from 'vitest'
import { env, createExecutionContext, createScheduledController, waitOnExecutionContext } from 'cloudflare:test'

// The daily cron hands each job's result to runJob, so a run that did no work
// (the week-ahead email's { skipped: 'not-today' }) can't mark a failure resolved.
vi.mock('../../src/lib/digest', () => ({ runDigest: vi.fn(async () => ({ ok: true, recipients: 0, sent: 0, failed: 0, skipped: 'not-today' })) }))
vi.mock('../../src/lib/weekAhead', () => ({ runWeekAhead: vi.fn(async () => ({ skipped: 'not-today' })) }))
vi.mock('../../src/lib/email', async (importOriginal) =>
  (await import('../mail')).withFakeSender(await importOriginal<typeof import('../../src/lib/email')>()))

import worker from '../../src/index'
import { runWeekAhead } from '../../src/lib/weekAhead'
import { mail, resetMail } from '../mail'
import { clearDb } from '../helpers'

const daily = async () => {
  const ctx = createExecutionContext()
  const e = { ...env, ALERT_EMAILS: 'ops@example.test', APP_URL: 'https://ut.example.test' }
  await worker.scheduled(createScheduledController({ cron: '0 11 * * *' }) as unknown as ScheduledEvent, e as any, ctx)
  await waitOnExecutionContext(ctx)
}

describe('the daily cron, after the week-ahead email failed', () => {
  beforeEach(async () => {
    await clearDb()
    resetMail()
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  it('sends no resolved email on a day the week-ahead email skips', async () => {
    vi.mocked(runWeekAhead).mockRejectedValueOnce(new Error('boom'))
    await daily()
    await daily()
    expect(mail.send.mock.calls.map(c => c[0].subject)).toEqual(['[FloorVote] cron failed: week-ahead on ut.example.test'])
  })

  it('sends the resolved email on the next day it does its work', async () => {
    vi.mocked(runWeekAhead).mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(undefined)
    await daily()
    await daily()
    expect(mail.send.mock.calls.map(c => c[0].subject)).toEqual([
      '[FloorVote] cron failed: week-ahead on ut.example.test',
      '[FloorVote] resolved: week-ahead on ut.example.test',
    ])
  })
})
