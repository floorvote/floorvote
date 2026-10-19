import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock the sender so no real send happens. `senderFor` records the db it is
// given (an alert must not be counted, so none), and `sendEmail` records each
// message the job alert sends, with its purpose.
type Sent = { purpose?: string; to: string[]; subject: string; html: string; text?: string }
const sendEmail = vi.fn(
  async (_env: any, _msg: Sent, _db?: unknown) =>
    ({ ok: true, provider: 'resend' as const }),
)
vi.mock('../../src/lib/email', () => ({
  senderFor: (env: any, db?: any) => ({ send: (msg: any) => sendEmail(env, msg, db) }),
}))

import { runJob, reportJobFailure } from '../../src/lib/jobAlert'

beforeEach(() => {
  sendEmail.mockClear()
  sendEmail.mockResolvedValue({ ok: true, provider: 'resend' })
})
afterEach(() => vi.restoreAllMocks())

const env = (over: Record<string, unknown> = {}) =>
  ({ ALERT_EMAILS: 'a@e.com, b@e.com', RESEND_API_KEY: 'k', ...over }) as any

describe('runJob', () => {
  it('resolves normally when fn succeeds and does not alert', async () => {
    const fn = vi.fn(async () => 'ok')
    await expect(runJob(env(), 'digest', fn)).resolves.toBeUndefined()
    expect(fn).toHaveBeenCalledOnce()
    expect(sendEmail).not.toHaveBeenCalled()
  })

  it('does NOT reject when fn throws, and triggers an alert', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const fn = vi.fn(async () => { throw new Error('boom') })
    await expect(runJob(env(), 'demo-reset', fn)).resolves.toBeUndefined()
    expect(sendEmail).toHaveBeenCalledOnce()
    const msg = sendEmail.mock.calls[0][1]
    expect(msg.subject).toContain('demo-reset')
  })
})

describe('reportJobFailure', () => {
  it('sends one email to all ALERT_EMAILS recipients, trimmed', async () => {
    await reportJobFailure(env(), { job: 'week-ahead', error: new Error('nope') })
    expect(sendEmail).toHaveBeenCalledOnce()
    const msg = sendEmail.mock.calls[0][1]
    expect(msg.to).toEqual(['a@e.com', 'b@e.com'])
    expect(msg.subject).toContain('week-ahead')
    expect(msg.html).toContain('nope')
  })

  it('sends with the operator purpose and no db, so alert mail is never counted in email_send_stats', async () => {
    await reportJobFailure(env({ DB: {} }), { job: 'week-ahead', error: new Error('nope') })
    expect(sendEmail).toHaveBeenCalledOnce()
    expect(sendEmail.mock.calls[0][1].purpose).toBe('operator')
    expect(sendEmail.mock.calls[0][2]).toBeUndefined()
  })

  it('does not decide fallback, From, or demo mode itself: the message carries only its purpose and content', async () => {
    await reportJobFailure(env(), { job: 'week-ahead', error: new Error('nope') })
    expect(sendEmail).toHaveBeenCalledOnce()
    expect(Object.keys(sendEmail.mock.calls[0][1]).sort()).toEqual(['html', 'purpose', 'subject', 'text', 'to'])
  })

  it('includes the stack when the error has one', async () => {
    const err = new Error('with-stack')
    await reportJobFailure(env(), { job: 'register', error: err })
    expect(sendEmail).toHaveBeenCalledOnce()
    const msg = sendEmail.mock.calls[0][1]
    expect(msg.html).toContain('with-stack')
    expect(String(msg.html)).toContain('Error')
  })

  it('handles non-Error throwables', async () => {
    await reportJobFailure(env(), { job: 'register', error: 'string-error' })
    expect(sendEmail).toHaveBeenCalledOnce()
    const msg = sendEmail.mock.calls[0][1]
    expect(msg.html).toContain('string-error')
  })

  it('does not throw if the send rejects', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    sendEmail.mockRejectedValueOnce(new Error('send-fail'))
    await expect(
      reportJobFailure(env(), { job: 'digest', error: new Error('x') }),
    ).resolves.toBeUndefined()
  })

  it('no-ops (no send) when ALERT_EMAILS is unset', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await reportJobFailure(env({ ALERT_EMAILS: undefined }), { job: 'digest', error: new Error('x') })
    expect(sendEmail).not.toHaveBeenCalled()
  })

  it('no-ops when ALERT_EMAILS is blank/only commas', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await reportJobFailure(env({ ALERT_EMAILS: ' , , ' }), { job: 'digest', error: new Error('x') })
    expect(sendEmail).not.toHaveBeenCalled()
  })
})
