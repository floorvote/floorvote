import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// The fake sender (test/mail.ts) stands in for the shared one, so no real send
// happens. `senderFor` records the db it is given (an alert must not be
// counted, so none), and `mail.send` records each message the job alert sends,
// with its purpose.
vi.mock('../../src/lib/email', async (importOriginal) =>
  (await import('../mail')).withFakeSender(await importOriginal<typeof import('../../src/lib/email')>()))

// The real conversation code runs against real D1. A test that needs it to
// fail makes this one call reject, as D1 does when it's overloaded.
vi.mock('../../src/lib/alertThread', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/alertThread')>()
  return { ...actual, joinJobAlertThread: vi.fn(actual.joinJobAlertThread), takeJobAlertThread: vi.fn(actual.takeJobAlertThread) }
})

import { env as testEnv } from 'cloudflare:test'
import { runJob, reportJobFailure } from '../../src/lib/jobAlert'
import { joinJobAlertThread, takeJobAlertThread } from '../../src/lib/alertThread'
import { mail, senderFor, resetMail } from '../mail'
import { clearDb } from '../helpers'

beforeEach(() => {
  resetMail()
})
afterEach(() => vi.restoreAllMocks())

const env = (over: Record<string, unknown> = {}) =>
  ({ ALERT_EMAILS: 'a@e.com, b@e.com', RESEND_API_KEY: 'k', ...over }) as any

describe('runJob', () => {
  it('resolves normally when fn succeeds and does not alert', async () => {
    const fn = vi.fn(async () => 'ok')
    await expect(runJob(env(), 'digest', fn)).resolves.toBeUndefined()
    expect(fn).toHaveBeenCalledOnce()
    expect(mail.send).not.toHaveBeenCalled()
  })

  it('does NOT reject when fn throws, and triggers an alert', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const fn = vi.fn(async () => { throw new Error('boom') })
    await expect(runJob(env(), 'demo-reset', fn)).resolves.toBeUndefined()
    expect(mail.send).toHaveBeenCalledOnce()
    const msg = mail.send.mock.calls[0][0]
    expect(msg.subject).toContain('demo-reset')
  })
})

describe('reportJobFailure', () => {
  it('sends one email to all ALERT_EMAILS recipients, trimmed', async () => {
    await reportJobFailure(env(), { job: 'week-ahead', error: new Error('nope') })
    expect(mail.send).toHaveBeenCalledOnce()
    const msg = mail.send.mock.calls[0][0]
    expect(msg.to).toEqual(['a@e.com', 'b@e.com'])
    expect(msg.subject).toContain('week-ahead')
    expect(msg.html).toContain('nope')
  })

  it('sends with the operator purpose and no db, so alert mail is never counted in email_send_stats', async () => {
    await reportJobFailure(env({ DB: {} }), { job: 'week-ahead', error: new Error('nope') })
    expect(mail.send).toHaveBeenCalledOnce()
    expect(mail.send.mock.calls[0][0].purpose).toBe('operator')
    expect(senderFor.mock.calls[0][1]).toBeUndefined()
  })

  it('does not decide fallback, From, or demo mode itself: the message carries only its purpose and content', async () => {
    await reportJobFailure(env(), { job: 'week-ahead', error: new Error('nope') })
    expect(mail.send).toHaveBeenCalledOnce()
    expect(Object.keys(mail.send.mock.calls[0][0]).sort()).toEqual(['html', 'purpose', 'subject', 'text', 'to'])
  })

  it('includes the stack when the error has one', async () => {
    const err = new Error('with-stack')
    await reportJobFailure(env(), { job: 'register', error: err })
    expect(mail.send).toHaveBeenCalledOnce()
    const msg = mail.send.mock.calls[0][0]
    expect(msg.html).toContain('with-stack')
    expect(String(msg.html)).toContain('Error')
  })

  it('handles non-Error throwables', async () => {
    await reportJobFailure(env(), { job: 'register', error: 'string-error' })
    expect(mail.send).toHaveBeenCalledOnce()
    const msg = mail.send.mock.calls[0][0]
    expect(msg.html).toContain('string-error')
  })

  it('does not throw if the send rejects', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    mail.send.mockRejectedValueOnce(new Error('send-fail'))
    await expect(
      reportJobFailure(env(), { job: 'digest', error: new Error('x') }),
    ).resolves.toBeUndefined()
  })

  it('no-ops (no send) when ALERT_EMAILS is unset', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await reportJobFailure(env({ ALERT_EMAILS: undefined }), { job: 'digest', error: new Error('x') })
    expect(mail.send).not.toHaveBeenCalled()
  })

  it('no-ops when ALERT_EMAILS is blank/only commas', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await reportJobFailure(env({ ALERT_EMAILS: ' , , ' }), { job: 'digest', error: new Error('x') })
    expect(mail.send).not.toHaveBeenCalled()
  })
})

// One malformed entry in ALERT_EMAILS must not block the alert to the good
// addresses (#781): the caller sends to the valid ones, logs the dropped ones,
// and fails (as it does for an unset ALERT_EMAILS) only when none are left.
describe('reportJobFailure: a malformed ALERT_EMAILS entry', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>
  beforeEach(() => { errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {}) })
  const logged = () => errorSpy.mock.calls.map(c => c.map(String).join(' ')).join('\n')
  const fail = (over: Record<string, unknown>) => reportJobFailure(env(over), { job: 'digest', error: new Error('boom') })

  it('sends to the valid address and logs the invalid entry', async () => {
    await fail({ ALERT_EMAILS: 'ops@example.com, not-an-address' })
    expect(mail.send).toHaveBeenCalledOnce()
    expect(mail.send.mock.calls[0][0]).toMatchObject({ purpose: 'operator', to: ['ops@example.com'] })
    expect(logged()).toContain('not-an-address')
    expect(logged()).toContain('ALERT_EMAILS')
  })

  it('sends to the valid addresses around an invalid one, in order', async () => {
    await fail({ ALERT_EMAILS: 'a@example.com, oops, b@example.com' })
    expect(mail.send.mock.calls[0][0].to).toEqual(['a@example.com', 'b@example.com'])
  })

  it('sends nothing, and logs both the entries and that no alert went out, when every entry is invalid', async () => {
    await expect(fail({ ALERT_EMAILS: 'oops, also@oops' })).resolves.toBeUndefined()
    expect(mail.send).not.toHaveBeenCalled()
    expect(logged()).toContain('oops')
    expect(logged()).toContain('also@oops')
    expect(logged()).toContain('[job:digest] failed but ALERT_EMAILS')
    expect(logged()).toContain('no alert sent')
  })

  it('sends to all of them, and logs nothing about addresses, when every entry is valid', async () => {
    await fail({ ALERT_EMAILS: 'a@example.com, b@example.com' })
    expect(mail.send.mock.calls[0][0].to).toEqual(['a@example.com', 'b@example.com'])
    expect(errorSpy).not.toHaveBeenCalled()
  })

  it('ignores blank entries and trims the rest without logging', async () => {
    await fail({ ALERT_EMAILS: ' a@example.com ,, , b@example.com ,' })
    expect(mail.send.mock.calls[0][0].to).toEqual(['a@example.com', 'b@example.com'])
    expect(errorSpy).not.toHaveBeenCalled()
  })

  it('sends to a duplicated address once, ignoring case', async () => {
    await fail({ ALERT_EMAILS: 'Ops@example.com, ops@example.com, b@example.com' })
    expect(mail.send.mock.calls[0][0].to).toEqual(['Ops@example.com', 'b@example.com'])
  })

  it('drops the display-name form and sends to the bare address beside it', async () => {
    await fail({ ALERT_EMAILS: 'Ops <ops@example.com>, b@example.com' })
    expect(mail.send.mock.calls[0][0].to).toEqual(['b@example.com'])
    expect(logged()).toContain('Ops <ops@example.com>')
  })

  it('keeps an upper-case address as written', async () => {
    await fail({ ALERT_EMAILS: 'OPS@EXAMPLE.COM, oops' })
    expect(mail.send.mock.calls[0][0].to).toEqual(['OPS@EXAMPLE.COM'])
  })

  it('runJob alerts the valid addresses when its job throws', async () => {
    await runJob(env({ ALERT_EMAILS: 'oops, ops@example.com' }), 'demo-reset', async () => { throw new Error('boom') })
    expect(mail.send).toHaveBeenCalledOnce()
    expect(mail.send.mock.calls[0][0].to).toEqual(['ops@example.com'])
  })
})


describe('job failures keep the reason', () => {
  const d1Failure = () => new Error('Failed query: select 1', { cause: new Error('D1_ERROR: D1 DB is overloaded.') })

  it("logs the error's whole cause chain as text, not only the Error object", async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await runJob(env(), 'heal-ai', async () => { throw d1Failure() })
    const line = spy.mock.calls.find(c => String(c[0]).startsWith('[job:heal-ai] failed'))
    expect(line).toBeDefined()
    expect(line!.filter(a => typeof a === 'string').join(' ')).toContain('Failed query: select 1 | caused by: D1_ERROR: D1 DB is overloaded.')
  })

  it("puts the cause's message in the alert email, text and HTML", async () => {
    await reportJobFailure(env(), { job: 'heal-ai', error: d1Failure() })
    const msg = mail.send.mock.calls[0][0]
    expect(msg.text).toContain('Error: Failed query: select 1 | caused by: D1_ERROR: D1 DB is overloaded.')
    expect(msg.html).toContain('D1_ERROR: D1 DB is overloaded.')
  })
})

// An instance's job alerts share one conversation per job and outage, kept in
// job_alert_threads (api/src/lib/alertThread.ts). Only events end it: a run
// that does its work (with a resolved email), or a run that finds the job
// switched off (quietly). Each alert names the instance, since one inbox gets
// them all.
describe('job failures: one conversation per outage', () => {
  const withDb = (over: Record<string, unknown> = {}) => env({ DB: testEnv.DB, APP_URL: 'https://ut.example.test', ...over })
  const sent = (i: number) => mail.send.mock.calls[i][0]
  beforeEach(async () => { await clearDb() })

  it('names the instance in the subject and the email', async () => {
    await reportJobFailure(withDb(), { job: 'digest', error: new Error('x') })
    expect(sent(0).subject).toBe('[FloorVote] cron failed: digest on ut.example.test')
    expect(sent(0).text).toContain('Scheduled job "digest" failed on ut.example.test and did not complete.')
    expect(sent(0).html).toContain('failed on ut.example.test')
  })

  it("carries the job's conversation headers, named by the failure subject", async () => {
    await reportJobFailure(withDb(), { job: 'digest', error: new Error('x') })
    const h = sent(0).headers
    expect(h.References).toMatch(/^<alert\.digest\.[a-z0-9]+@ut\.example\.test>$/)
    expect(h['In-Reply-To']).toBe(h.References)
    expect(h['Thread-Topic']).toBe(sent(0).subject)
    expect(h['Thread-Index']).toMatch(/^[A-Za-z0-9+/]{30}==$/)
  })

  it("puts a job's repeated failures in one conversation", async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await reportJobFailure(withDb(), { job: 'digest', error: new Error('x') })
    await runJob(withDb(), 'digest', async () => { throw new Error('y') })
    expect(sent(0).headers?.References).toMatch(/^<alert\.digest\./)
    expect(sent(1).headers).toEqual(sent(0).headers)
  })

  it('gives each job its own conversation', async () => {
    await reportJobFailure(withDb(), { job: 'digest', error: new Error('x') })
    await reportJobFailure(withDb(), { job: 'week-ahead', error: new Error('x') })
    expect(sent(1).headers.References).toMatch(/^<alert\.week-ahead\./)
    expect(sent(1).headers.References).not.toBe(sent(0).headers.References)
  })

  it("keeps two instances' alerts apart", async () => {
    await reportJobFailure(withDb(), { job: 'digest', error: new Error('x') })
    await reportJobFailure(withDb({ APP_URL: 'https://tx.example.test' }), { job: 'digest', error: new Error('x') })
    expect(sent(0).headers.References).toContain('@ut.example.test>')
    expect(sent(1).headers.References).toContain('@tx.example.test>')
  })

  it("keeps a job's failures in one conversation however far apart they are, since only a run that does its work ends it", async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(Date.parse('2026-11-02T11:00:00Z'))
      await reportJobFailure(withDb(), { job: 'digest', error: new Error('x') })
      vi.setSystemTime(Date.parse('2026-11-20T11:00:00Z'))
      await reportJobFailure(withDb(), { job: 'digest', error: new Error('x') })
    } finally { vi.useRealTimers() }
    expect(sent(0).headers.References).toMatch(/^<alert\.digest\./)
    expect(sent(1).headers.References).toBe(sent(0).headers.References)
  })

  it("still sends, on its own, when the conversation can't be recorded", async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(joinJobAlertThread).mockRejectedValueOnce(new Error('D1_ERROR: D1 DB is overloaded.'))
    await reportJobFailure(withDb(), { job: 'digest', error: new Error('x') })
    expect(mail.send).toHaveBeenCalledOnce()
    expect(sent(0).headers).toBeUndefined()
  })

  it("sends on its own, naming no instance, when the instance's address can't be read", async () => {
    await reportJobFailure(withDb({ APP_URL: 'not a url' }), { job: 'digest', error: new Error('x') })
    expect(sent(0).subject).toBe('[FloorVote] cron failed: digest')
    expect(sent(0).headers).toBeUndefined()
  })

  it('sends the alert once more, without its conversation headers, when a provider refuses it with them', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    mail.send.mockResolvedValueOnce({ ok: false, provider: 'cloudflare', error: 'E_VALIDATION_ERROR: test', permanent: false, attempts: [] } as never)
    await reportJobFailure(withDb(), { job: 'digest', error: new Error('x') })
    expect(mail.send).toHaveBeenCalledTimes(2)
    expect(sent(0).headers?.References).toMatch(/^<alert\.digest\./)
    expect(sent(1).headers).toBeUndefined()
  })
})

// Once a job whose failure alerted runs again and does its work, it sends one
// resolved email in that conversation, which then ends. A run that isn't the
// job's day says { skipped: 'not-today' } and doesn't count. One that finds the
// job switched off says { skipped: 'off' } and ends the conversation quietly.
describe('job recoveries', () => {
  const withDb = (over: Record<string, unknown> = {}) => env({ DB: testEnv.DB, APP_URL: 'https://ut.example.test', ...over })
  const sent = (i: number) => mail.send.mock.calls[i][0]
  const failRun = () => runJob(withDb(), 'digest', async () => { throw new Error('boom') })
  beforeEach(async () => {
    await clearDb()
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  it("sends one resolved email in the job's conversation once a run does its work, and the next failure starts a new one", async () => {
    // A daily job: it fails one morning, works the next, and fails again two days on.
    const day = (d: number) => vi.setSystemTime(Date.parse(`2026-11-${String(d).padStart(2, '0')}T11:00:00Z`))
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      day(9); await failRun()
      day(10); await runJob(withDb(), 'digest', async () => ({ ok: true, recipients: 3, sent: 3, failed: 0 }))
      expect(mail.send).toHaveBeenCalledTimes(2)
      expect(sent(1).subject).toBe('[FloorVote] resolved: digest on ut.example.test')
      expect(sent(1).text).toContain('Scheduled job "digest" ran on ut.example.test without an error, after failing since 2026-11-09 11:00:00 UTC.')
      expect(sent(1).headers).toEqual(sent(0).headers)
      day(11); await runJob(withDb(), 'digest', async () => undefined)
      expect(mail.send).toHaveBeenCalledTimes(2)
      day(12); await failRun()
    } finally { vi.useRealTimers() }
    expect(sent(2).headers.References).toMatch(/^<alert\.digest\./)
    expect(sent(2).headers.References).not.toBe(sent(0).headers.References)
  })

  it('sends nothing after a run when the job had no open conversation', async () => {
    await runJob(withDb(), 'digest', async () => undefined)
    expect(mail.send).not.toHaveBeenCalled()
  })

  it("doesn't count a run that skipped its work as recovered", async () => {
    await failRun()
    await runJob(withDb(), 'digest', async () => ({ ok: true, recipients: 0, sent: 0, failed: 0, skipped: 'not-today' }))
    expect(mail.send).toHaveBeenCalledOnce()
    await runJob(withDb(), 'digest', async () => undefined)
    expect(sent(1).subject).toContain('resolved: digest')
  })

  it("keeps a weekly job's failed weeks in one conversation, and its resolved email names when the outage began", async () => {
    const at = (d: string) => vi.setSystemTime(Date.parse(`2026-11-${d}T11:00:00Z`))
    const fail = () => runJob(withDb(), 'week-ahead', async () => { throw new Error('boom') })
    const skip = () => runJob(withDb(), 'week-ahead', async () => ({ skipped: 'not-today' }))
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      at('02'); await fail()
      for (const d of ['03', '04', '05', '06', '07', '08']) { at(d); await skip() }
      at('09'); await fail()
      for (const d of ['10', '11', '12', '13', '14', '15']) { at(d); await skip() }
      at('16'); await runJob(withDb(), 'week-ahead', async () => undefined)
    } finally { vi.useRealTimers() }
    expect(mail.send.mock.calls.map(c => c[0].subject)).toEqual([
      '[FloorVote] cron failed: week-ahead on ut.example.test',
      '[FloorVote] cron failed: week-ahead on ut.example.test',
      '[FloorVote] resolved: week-ahead on ut.example.test',
    ])
    expect(sent(1).headers.References).toBe(sent(0).headers.References)
    expect(sent(2).headers).toEqual(sent(0).headers)
    expect(sent(2).text).toContain('after failing since 2026-11-02 11:00:00 UTC')
  })

  it('says the job has failed since its first failure, not its latest', async () => {
    const day = (d: number) => vi.setSystemTime(Date.parse(`2026-11-${String(d).padStart(2, '0')}T11:00:00Z`))
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      day(9); await failRun()
      day(10); await failRun()
      day(11); await runJob(withDb(), 'digest', async () => undefined)
    } finally { vi.useRealTimers() }
    expect(sent(2).text).toContain('after failing since 2026-11-09 11:00:00 UTC')
  })

  it("ends only its own job's conversation, as a week-ahead run right after a failed digest does", async () => {
    await failRun()
    await runJob(withDb(), 'week-ahead', async () => undefined)
    expect(mail.send).toHaveBeenCalledOnce()
    await runJob(withDb(), 'digest', async () => undefined)
    expect(sent(1).subject).toBe('[FloorVote] resolved: digest on ut.example.test')
    expect(sent(1).headers).toEqual(sent(0).headers)
  })

  it('ends the conversation quietly when a run finds the job switched off, so its next failure starts a new one', async () => {
    const day = (d: number) => vi.setSystemTime(Date.parse(`2026-11-${String(d).padStart(2, '0')}T11:00:00Z`))
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      day(2); await failRun()
      day(3); await runJob(withDb(), 'digest', async () => ({ ok: true, recipients: 0, sent: 0, failed: 0, skipped: 'off' }))
      expect(mail.send).toHaveBeenCalledOnce()
      day(20); await failRun()
    } finally { vi.useRealTimers() }
    expect(sent(1).subject).toContain('cron failed: digest')
    expect(sent(1).headers.References).toMatch(/^<alert\.digest\./)
    expect(sent(1).headers.References).not.toBe(sent(0).headers.References)
  })

  it('still sends the resolved email when the next run that does its work comes weeks later', async () => {
    const day = (d: number) => vi.setSystemTime(Date.parse(`2026-11-${String(d).padStart(2, '0')}T11:00:00Z`))
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      day(2); await failRun()
      day(25); await runJob(withDb(), 'digest', async () => undefined)
    } finally { vi.useRealTimers() }
    expect(sent(1).subject).toBe('[FloorVote] resolved: digest on ut.example.test')
    expect(sent(1).headers).toEqual(sent(0).headers)
    expect(sent(1).text).toContain('after failing since 2026-11-02 11:00:00 UTC')
  })

  it("never throws, and sends nothing, when the conversation can't be read after a run", async () => {
    await failRun()
    vi.mocked(takeJobAlertThread).mockRejectedValueOnce(new Error('D1_ERROR: D1 DB is overloaded.'))
    await expect(runJob(withDb(), 'digest', async () => undefined)).resolves.toBeUndefined()
    expect(mail.send).toHaveBeenCalledOnce()
  })
})
