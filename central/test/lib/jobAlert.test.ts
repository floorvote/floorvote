import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { runJob, reportJobFailure, sendOpsAlert } from '../../src/lib/jobAlert'
import { fakeBinding, stubResend, bothBindingFirst, bothResendFirst, RESEND_KEY } from '../../../shared/emailTestKit'

// jobAlert goes through the shared sender with the operator purpose. These
// tests drive it with fake providers; shared/emailSender.test.ts covers the
// purpose's rules against in-memory adapters.

let errorSpy: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

const resendOnly = (over: Record<string, unknown> = {}) =>
  ({ ALERT_EMAILS: 'a@e.com, b@e.com', RESEND_API_KEY: RESEND_KEY, ...over }) as any
const both = (binding: unknown, over: Record<string, unknown> = {}) =>
  ({ ALERT_EMAILS: 'a@e.com, b@e.com', ...bothBindingFirst(binding), ...over }) as any

describe('central runJob', () => {
  it('resolves when fn succeeds; no alert', async () => {
    const resend = stubResend('ok')
    await expect(runJob(resendOnly(), 'sync', vi.fn(async () => 'ok'))).resolves.toBeUndefined()
    expect(resend.calls).toHaveLength(0)
  })

  it('does not reject when fn throws; alerts', async () => {
    const resend = stubResend('ok')
    await expect(runJob(resendOnly(), 'sync', vi.fn(async () => { throw new Error('boom') }))).resolves.toBeUndefined()
    expect(resend.calls).toHaveLength(1)
    expect(resend.calls[0].body.subject).toContain('sync')
  })

  it('still alerts through the second provider when the first is down', async () => {
    const cf = fakeBinding('down')
    const resend = stubResend('ok')
    await runJob(both(cf.binding), 'sync', async () => { throw new Error('boom') })
    expect(cf.sent).toHaveLength(1)
    expect(resend.calls).toHaveLength(1)
    expect(resend.calls[0].body.subject).toContain('sync')
  })
})

describe('central reportJobFailure', () => {
  it('sends one email to all trimmed recipients with job + error in body', async () => {
    const resend = stubResend('ok')
    await reportJobFailure(resendOnly(), { job: 'engagement-pull', error: new Error('nope') })
    expect(resend.calls).toHaveLength(1)
    const msg = resend.calls[0].body
    expect(msg.to).toEqual(['a@e.com', 'b@e.com'])
    expect(msg.subject).toContain('engagement-pull')
    expect(msg.html).toContain('nope')
  })

  it('does not throw when the provider is down', async () => {
    stubResend('down')
    await expect(reportJobFailure(resendOnly(), { job: 'sync', error: new Error('x') })).resolves.toBeUndefined()
  })

  it('does not throw when fetch throws', async () => {
    stubResend('throw')
    await expect(reportJobFailure(resendOnly(), { job: 'sync', error: new Error('x') })).resolves.toBeUndefined()
  })

  it('no-ops when ALERT_EMAILS unset', async () => {
    const resend = stubResend('ok')
    await reportJobFailure(resendOnly({ ALERT_EMAILS: undefined }), { job: 'sync', error: new Error('x') })
    expect(resend.calls).toHaveLength(0)
  })
})

describe('central sendOpsAlert: delivery', () => {
  it('sends to all recipients with subject/text/html', async () => {
    const resend = stubResend('ok')
    await sendOpsAlert(resendOnly(), { subject: 'sub', text: 'body', html: '<p>body</p>' })
    expect(resend.calls).toHaveLength(1)
    const msg = resend.calls[0].body
    expect(msg.to).toEqual(['a@e.com', 'b@e.com'])
    expect(msg.subject).toBe('sub')
    expect(msg.text).toBe('body')
    expect(msg.html).toBe('<p>body</p>')
  })

  it('sends through the binding alone when that is the only provider', async () => {
    const cf = fakeBinding('ok')
    const resend = stubResend('ok')
    await sendOpsAlert({ ALERT_EMAILS: 'a@e.com', EMAIL_PROVIDER: 'cloudflare', EMAIL: cf.binding } as any, { subject: 's', text: 't', html: 'h' })
    expect(cf.sent).toHaveLength(1)
    expect(resend.calls).toHaveLength(0)
  })

  it('no-ops when no recipients', async () => {
    const resend = stubResend('ok')
    await sendOpsAlert(resendOnly({ ALERT_EMAILS: undefined }), { subject: 's', text: 't', html: 'h' })
    expect(resend.calls).toHaveLength(0)
  })

  it('sends in demo mode: operator mail is never suppressed', async () => {
    const resend = stubResend('ok')
    await sendOpsAlert(resendOnly({ DEMO_MODE: 'true' }), { subject: 's', text: 't', html: 'h' })
    expect(resend.calls).toHaveLength(1)
  })

  it('uses the default From, not the bulk one', async () => {
    const resend = stubResend('ok')
    await sendOpsAlert(resendOnly({ EMAIL_FROM: 'alerts@example.org', EMAIL_FROM_BULK: 'bulk@mail.example.org' }), { subject: 's', text: 't', html: 'h' })
    expect(resend.calls[0].body.from).toBe('FloorVote <alerts@example.org>')
  })
})

describe('central sendOpsAlert: fallback (operator purpose)', () => {
  it('falls back to Resend when the binding, tried first, is down', async () => {
    const cf = fakeBinding('down')
    const resend = stubResend('ok')
    await sendOpsAlert(both(cf.binding), { subject: 'sub', text: 'body', html: '<p>body</p>' })
    expect(cf.sent).toHaveLength(1)
    expect(resend.calls).toHaveLength(1)
    expect(resend.calls[0].body.to).toEqual(['a@e.com', 'b@e.com'])
    expect(resend.calls[0].body.subject).toBe('sub')
  })

  it('falls back to the binding when Resend, tried first, is down', async () => {
    const cf = fakeBinding('ok')
    const resend = stubResend('down')
    await sendOpsAlert({ ALERT_EMAILS: 'a@e.com', ...bothResendFirst(cf.binding) } as any, { subject: 'sub', text: 'body', html: '<p>body</p>' })
    expect(resend.calls).toHaveLength(1)
    expect(cf.sent).toHaveLength(1)
    expect(cf.sent[0].subject).toBe('sub')
  })

  it('falls back when the first provider is unreachable (fetch throws)', async () => {
    const cf = fakeBinding('ok')
    const resend = stubResend('throw')
    await sendOpsAlert({ ALERT_EMAILS: 'a@e.com', ...bothResendFirst(cf.binding) } as any, { subject: 'sub', text: 'body', html: 'h' })
    expect(resend.calls).toHaveLength(1)
    expect(cf.sent).toHaveLength(1)
  })

  it('does not touch the second provider when the first succeeds', async () => {
    const cf = fakeBinding('ok')
    const resend = stubResend('ok')
    await sendOpsAlert(both(cf.binding), { subject: 's', text: 't', html: 'h' })
    expect(cf.sent).toHaveLength(1)
    expect(resend.calls).toHaveLength(0)
  })

  it('does not throw, and logs the failure, when both providers are down', async () => {
    const cf = fakeBinding('down')
    const resend = stubResend('down')
    await expect(sendOpsAlert(both(cf.binding), { subject: 'the-subject', text: 't', html: 'h' })).resolves.toBeUndefined()
    expect(cf.sent).toHaveLength(1)
    expect(resend.calls).toHaveLength(1)
    expect(errorSpy.mock.calls.map((c) => c.map(String).join(' ')).join('\n')).toContain('[ops-alert]')
  })

  it('does not throw when the binding throws synchronously and Resend is not configured', async () => {
    const cf = fakeBinding('throw-sync')
    await expect(sendOpsAlert({ ALERT_EMAILS: 'a@e.com', EMAIL_PROVIDER: 'cloudflare', EMAIL: cf.binding } as any, { subject: 's', text: 't', html: 'h' })).resolves.toBeUndefined()
  })

  it('does not throw, calls nothing, and logs when no provider is configured', async () => {
    const resend = stubResend('ok')
    await expect(sendOpsAlert({ ALERT_EMAILS: 'a@e.com' } as any, { subject: 's', text: 't', html: 'h' })).resolves.toBeUndefined()
    expect(resend.calls).toHaveLength(0)
    expect(errorSpy).toHaveBeenCalled()
  })
})

// One malformed entry in ALERT_EMAILS must not block the ops alert to the good
// addresses (#781). The sender rejects a whole message over one bad address, so
// before this a single typo silenced every alert. Every central ops alert (job
// failures, anomaly watch, a provider's `ctx.alert`) goes through sendOpsAlert,
// so these cover them all.
describe('central ops alerts: a malformed ALERT_EMAILS entry', () => {
  const note = { subject: 'the-subject', text: 't', html: 'h' }
  const logged = () => errorSpy.mock.calls.map((c) => c.map(String).join(' ')).join('\n')
  const alertTo = (list: string | undefined) => resendOnly({ ALERT_EMAILS: list })

  it('sendOpsAlert sends to the valid address and logs the invalid entry', async () => {
    const resend = stubResend('ok')
    await sendOpsAlert(alertTo('ops@example.com, not-an-address'), note)
    expect(resend.calls).toHaveLength(1)
    expect(resend.calls[0].body.to).toEqual(['ops@example.com'])
    expect(logged()).toContain('not-an-address')
    expect(logged()).toContain('ALERT_EMAILS')
  })

  it('reportJobFailure sends to the valid address and logs the invalid entry', async () => {
    const resend = stubResend('ok')
    await reportJobFailure(alertTo('ops@example.com, not-an-address'), { job: 'sync', error: new Error('boom') })
    expect(resend.calls[0].body.to).toEqual(['ops@example.com'])
    expect(resend.calls[0].body.subject).toContain('sync')
    expect(logged()).toContain('not-an-address')
  })

  it('reportJobFailure logs the invalid entry once, not again when it hands the alert to the sender', async () => {
    stubResend('ok')
    await reportJobFailure(alertTo('ops@example.com, not-an-address'), { job: 'sync', error: new Error('boom') })
    expect(logged().match(/not-an-address/g)).toHaveLength(1)
  })

  it('runJob alerts the valid address when its job throws', async () => {
    const resend = stubResend('ok')
    await runJob(alertTo('oops, ops@example.com'), 'sync', async () => { throw new Error('boom') })
    expect(resend.calls).toHaveLength(1)
    expect(resend.calls[0].body.to).toEqual(['ops@example.com'])
  })

  it('still falls back to the second provider, for the valid addresses only', async () => {
    const cf = fakeBinding('down')
    const resend = stubResend('ok')
    await sendOpsAlert(both(cf.binding, { ALERT_EMAILS: 'oops, a@e.com, b@e.com' }), note)
    expect(cf.sent).toHaveLength(1)
    expect(cf.sent[0].to).toEqual(['a@e.com', 'b@e.com'])
    expect(resend.calls[0].body.to).toEqual(['a@e.com', 'b@e.com'])
  })

  it('sendOpsAlert sends nothing, does not throw, and logs the entries and the suppressed alert, when every entry is invalid', async () => {
    const resend = stubResend('ok')
    await expect(sendOpsAlert(alertTo('oops, also@oops'), note)).resolves.toBeUndefined()
    expect(resend.calls).toHaveLength(0)
    expect(logged()).toContain('also@oops')
    expect(logged()).toContain('"the-subject" suppressed')
  })

  it('reportJobFailure sends nothing and logs that no alert went out, when every entry is invalid', async () => {
    const resend = stubResend('ok')
    await expect(reportJobFailure(alertTo('oops, also@oops'), { job: 'sync', error: new Error('x') })).resolves.toBeUndefined()
    expect(resend.calls).toHaveLength(0)
    expect(logged()).toContain('also@oops')
    expect(logged()).toContain('[job:sync] failed but ALERT_EMAILS')
    expect(logged()).toContain('no alert sent')
  })

  it('sends to every address, with nothing logged about addresses, when all are valid', async () => {
    const resend = stubResend('ok')
    await sendOpsAlert(alertTo('a@e.com, b@e.com'), note)
    expect(resend.calls[0].body.to).toEqual(['a@e.com', 'b@e.com'])
    expect(logged()).not.toContain('ALERT_EMAILS')
  })

  it('ignores blank entries and trims the rest', async () => {
    const resend = stubResend('ok')
    await sendOpsAlert(alertTo(' a@e.com ,, , b@e.com ,'), note)
    expect(resend.calls[0].body.to).toEqual(['a@e.com', 'b@e.com'])
    expect(errorSpy).not.toHaveBeenCalled()
  })

  it('sends to a duplicated address once, ignoring case', async () => {
    const resend = stubResend('ok')
    await sendOpsAlert(alertTo('A@e.com, a@e.com, b@e.com'), note)
    expect(resend.calls[0].body.to).toEqual(['A@e.com', 'b@e.com'])
  })

  it('drops the display-name form, and sends to the bare address beside it', async () => {
    const resend = stubResend('ok')
    await sendOpsAlert(alertTo('Ops <ops@example.com>, b@e.com'), note)
    expect(resend.calls[0].body.to).toEqual(['b@e.com'])
    expect(logged()).toContain('Ops <ops@example.com>')
  })

  it('keeps an upper-case address as written', async () => {
    const resend = stubResend('ok')
    await sendOpsAlert(alertTo('OPS@EXAMPLE.COM, oops'), note)
    expect(resend.calls[0].body.to).toEqual(['OPS@EXAMPLE.COM'])
  })
})

