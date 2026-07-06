import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const sendEmail = vi.fn(async () => ({ ok: true, provider: 'resend' as const }))
vi.mock('../../src/lib/email', () => ({ sendEmail: (...args: any[]) => sendEmail(...args) }))

import { runJob, reportJobFailure, sendOpsAlert } from '../../src/lib/jobAlert'

beforeEach(() => {
  sendEmail.mockClear()
  sendEmail.mockResolvedValue({ ok: true, provider: 'resend' })
})
afterEach(() => vi.restoreAllMocks())

const env = (over: Record<string, unknown> = {}) =>
  ({ ALERT_EMAILS: 'a@e.com, b@e.com', RESEND_API_KEY: 'k', ...over }) as any

describe('central runJob', () => {
  it('resolves when fn succeeds; no alert', async () => {
    await expect(runJob(env(), 'sync', vi.fn(async () => 'ok'))).resolves.toBeUndefined()
    expect(sendEmail).not.toHaveBeenCalled()
  })

  it('does not reject when fn throws; alerts', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(runJob(env(), 'sync', vi.fn(async () => { throw new Error('boom') }))).resolves.toBeUndefined()
    expect(sendEmail).toHaveBeenCalledOnce()
    expect(sendEmail.mock.calls[0][1].subject).toContain('sync')
  })
})

describe('central reportJobFailure', () => {
  it('sends one email to all trimmed recipients with job + error in body', async () => {
    await reportJobFailure(env(), { job: 'engagement-pull', error: new Error('nope') })
    expect(sendEmail).toHaveBeenCalledOnce()
    const msg = sendEmail.mock.calls[0][1]
    expect(msg.to).toEqual(['a@e.com', 'b@e.com'])
    expect(msg.subject).toContain('engagement-pull')
    expect(msg.html).toContain('nope')
  })

  it('does not throw when sendEmail throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    sendEmail.mockRejectedValueOnce(new Error('send-fail'))
    await expect(reportJobFailure(env(), { job: 'sync', error: new Error('x') })).resolves.toBeUndefined()
  })

  it('no-ops when ALERT_EMAILS unset', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await reportJobFailure(env({ ALERT_EMAILS: undefined }), { job: 'sync', error: new Error('x') })
    expect(sendEmail).not.toHaveBeenCalled()
  })
})

describe('central sendOpsAlert', () => {
  it('sends to all recipients with subject/text/html', async () => {
    await sendOpsAlert(env(), { subject: 'sub', text: 'body', html: '<p>body</p>' })
    expect(sendEmail).toHaveBeenCalledOnce()
    const msg = sendEmail.mock.calls[0][1]
    expect(msg.to).toEqual(['a@e.com', 'b@e.com'])
    expect(msg.subject).toBe('sub')
    expect(msg.text).toBe('body')
    expect(msg.html).toBe('<p>body</p>')
  })

  it('no-ops when no recipients', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await sendOpsAlert(env({ ALERT_EMAILS: undefined }), { subject: 's', text: 't', html: 'h' })
    expect(sendEmail).not.toHaveBeenCalled()
  })

  it('does not throw when sendEmail throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    sendEmail.mockRejectedValueOnce(new Error('send-fail'))
    await expect(sendOpsAlert(env(), { subject: 's', text: 't', html: 'h' })).resolves.toBeUndefined()
  })
})
