import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// The fake sender (test/mail.ts) stands in for the shared one, so no real send
// happens. `senderFor` records the db it is given (an alert must not be
// counted, so none), and `mail.send` records each message the job alert sends,
// with its purpose.
vi.mock('../../src/lib/email', async (importOriginal) =>
  (await import('../mail')).withFakeSender(await importOriginal<typeof import('../../src/lib/email')>()))

import { runJob, reportJobFailure } from '../../src/lib/jobAlert'
import { mail, senderFor, resetMail } from '../mail'

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

