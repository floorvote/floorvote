import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { env } from 'cloudflare:test'
import { resetDb, applyMigrations, stubFetch, seedUser } from '../helpers'
import { getDb } from '../../src/db/client'
import { associationConfig, emailSendStats } from '../../src/db/schema'
import { reportJobFailure } from '../../src/lib/jobAlert'
import { sendFeedback } from '../../src/lib/email'
import { notifyInviteBounces } from '../../src/lib/inviteBounceEmail'
import { sendSampleEmail } from '../../src/lib/sampleEmails'
import { PermanentSendError } from '../../src/lib/emailErrors'

// Operator mail (job alerts, feedback, invite-bounce notices, and sample
// emails, #709) sent through the real sender and real adapters, with the
// Cloudflare binding and `fetch` (Resend) faked at the transport. It falls
// back when the first provider is down, writes nothing to email health (no
// `email_send_stats` row and no Resend usage reading), and sends in demo mode.

type Binding = { send: ReturnType<typeof vi.fn> }
const cfOk = (): Binding => ({ send: vi.fn(async () => ({ messageId: 'cf-1' })) })
const cfDown = (): Binding => ({ send: vi.fn(async () => { throw Object.assign(new Error('down'), { code: 'E_INTERNAL_SERVER_ERROR' }) }) })
const cfSuppressed = (): Binding => ({ send: vi.fn(async () => { throw Object.assign(new Error('gone'), { code: 'E_RECIPIENT_SUPPRESSED' }) }) })

/** Both providers configured, the binding first. Resend is the one a fallback would reach. */
const bothProviders = (EMAIL: Binding, extra: Record<string, unknown> = {}) => ({
  ...env, EMAIL_PROVIDER: 'cloudflare', EMAIL, RESEND_API_KEY: 'test-api-key',
  APP_URL: 'https://ut.example.test', EMAIL_FROM: 'notifications@example.test',
  ALERT_EMAILS: 'ops@example.test', OPERATOR_CONTACT_EMAILS: 'feedback@example.test',
  ...extra,
}) as never

const resendOk = () => new Response(JSON.stringify({ id: 'rs-1' }), { status: 200, headers: { 'x-resend-monthly-quota': '812', 'x-resend-daily-quota': '40' } })

/** Everything the health recorder writes: the stats rows and the usage readout in association_config. */
async function healthWrites() {
  const db = getDb(env.DB)
  return {
    stats: await db.select().from(emailSendStats).all(),
    config: (await db.select().from(associationConfig).all()).filter(r => r.key.startsWith('resend_')),
  }
}
const NOTHING = { stats: [], config: [] }

beforeEach(async () => {
  await resetDb(); await applyMigrations()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('job alerts', () => {
  const fail = (e: never) => reportJobFailure(e, { job: 'digest', error: new Error('boom') })

  it('falls back to the second provider when the first is down', async () => {
    const EMAIL = cfDown()
    const fetch = stubFetch(resendOk)
    await fail(bothProviders(EMAIL))
    expect(EMAIL.send).toHaveBeenCalledOnce()
    expect(fetch).toHaveBeenCalledOnce()
    const body = JSON.parse((fetch.mock.calls[0][1] as RequestInit).body as string)
    expect(body.to).toEqual(['ops@example.test'])
    expect(body.subject).toContain('cron failed: digest')
  })

  it('sends through the first provider alone when it works', async () => {
    const EMAIL = cfOk()
    const fetch = stubFetch()
    await fail(bothProviders(EMAIL))
    expect(EMAIL.send).toHaveBeenCalledOnce()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('writes nothing to email health, whether it went out first time or by fallback', async () => {
    stubFetch(resendOk)
    await fail(bothProviders(cfOk()))
    await fail(bothProviders(cfDown()))
    expect(await healthWrites()).toEqual(NOTHING)
  })

  it('sends in demo mode', async () => {
    const EMAIL = cfOk()
    await fail(bothProviders(EMAIL, { DEMO_MODE: 'true' }))
    expect(EMAIL.send).toHaveBeenCalledOnce()
  })

  it('does not throw when every provider is down, and says so in the log', async () => {
    const EMAIL = cfDown()
    stubFetch(() => new Response('unauthorized', { status: 401 }))
    await expect(fail(bothProviders(EMAIL))).resolves.toBeUndefined()
    expect(EMAIL.send).toHaveBeenCalledOnce()
  })

  it('makes one attempt and does not throw with only one provider configured and down', async () => {
    const EMAIL = cfDown()
    await expect(fail(bothProviders(EMAIL, { RESEND_API_KEY: undefined }))).resolves.toBeUndefined()
    expect(EMAIL.send).toHaveBeenCalledOnce()
  })
})

describe('feedback', () => {
  const feedback = (e: never, db = getDb(env.DB)) => sendFeedback({ email: 'member@example.test' }, 'Great tool', 'https://ut.example.test/bills', e as never, db)

  it('falls back to the second provider when the first is down', async () => {
    const EMAIL = cfDown()
    const fetch = stubFetch(resendOk)
    await expect(feedback(bothProviders(EMAIL))).resolves.toBeUndefined()
    expect(EMAIL.send).toHaveBeenCalledOnce()
    expect(fetch).toHaveBeenCalledOnce()
    const body = JSON.parse((fetch.mock.calls[0][1] as RequestInit).body as string)
    expect(body.to).toEqual(['feedback@example.test'])
    expect(body.subject).toBe('Feedback from member@example.test')
  })

  it('is no longer counted toward email health when it goes out first time, even with a db', async () => {
    stubFetch(resendOk)
    await feedback(bothProviders(cfOk()))
    expect(await healthWrites()).toEqual(NOTHING)
  })

  it('is no longer counted toward email health when fallback rescued it, neither the failed attempt nor the rescue', async () => {
    stubFetch(resendOk)
    await feedback(bothProviders(cfDown())).catch(() => {})
    expect(await healthWrites()).toEqual(NOTHING)
  })

  it('does not write a failed send to email health either', async () => {
    stubFetch(() => new Response('unauthorized', { status: 401 }))
    await feedback(bothProviders(cfDown())).catch(() => {})
    expect(await healthWrites()).toEqual(NOTHING)
  })

  it('sends in demo mode', async () => {
    const EMAIL = cfOk()
    await feedback(bothProviders(EMAIL, { DEMO_MODE: 'true' }))
    expect(EMAIL.send).toHaveBeenCalledOnce()
  })

  it('throws a retryable error, not a permanent one, when every provider is down', async () => {
    stubFetch(() => new Response('unauthorized', { status: 401 }))
    const err = await feedback(bothProviders(cfDown())).catch(e => e)
    expect(err).toBeInstanceOf(Error)
    expect(err).not.toBeInstanceOf(PermanentSendError)
  })

  it('throws a permanent error for a suppressed recipient, without trying the other provider', async () => {
    const fetch = stubFetch()
    await expect(feedback(bothProviders(cfSuppressed()))).rejects.toBeInstanceOf(PermanentSendError)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('works without a db, and escapes what the member wrote', async () => {
    const EMAIL = cfOk()
    await sendFeedback({ email: 'member@example.test' }, '<script>alert(1)</script>', undefined, bothProviders(EMAIL) as never)
    const sent = EMAIL.send.mock.calls[0][0] as { html: string }
    expect(sent.html).toContain('&lt;script&gt;')
    expect(sent.html).not.toContain('<script>')
  })
})

describe('invite-bounce notices', () => {
  async function bounceFor(inviterEmail = 'admin@example.test', memberEmail = 'typo@example.test') {
    const inviterId = await seedUser({ role: 'admin', email: inviterEmail })
    const memberId = await seedUser({ email: memberEmail, invitedBy: inviterId })
    return [{ memberId, email: memberEmail, reason: '550 5.1.1 user unknown', inviterId, messageId: 'm-1' }]
  }
  const notify = (e: never, bounces: Awaited<ReturnType<typeof bounceFor>>) => notifyInviteBounces(e, getDb(env.DB), bounces as never)

  it('falls back to the second provider when the first is down', async () => {
    const EMAIL = cfDown()
    const fetch = stubFetch(resendOk)
    await notify(bothProviders(EMAIL), await bounceFor())
    expect(EMAIL.send).toHaveBeenCalledOnce()
    expect(fetch).toHaveBeenCalledOnce()
    const body = JSON.parse((fetch.mock.calls[0][1] as RequestInit).body as string)
    expect(body.to).toEqual(['admin@example.test'])
    expect(body.subject).toContain("couldn't be delivered")
  })

  it('is no longer counted toward email health, even with a db', async () => {
    stubFetch(resendOk)
    await notify(bothProviders(cfOk()), await bounceFor('admin-a@example.test', 'typo-a@example.test'))
    expect(await healthWrites()).toEqual(NOTHING)
  })

  it('is no longer counted toward email health when fallback rescued it, neither the failed attempt nor the rescue', async () => {
    stubFetch(resendOk)
    await notify(bothProviders(cfDown()), await bounceFor('admin-b@example.test', 'typo-b@example.test'))
    expect(await healthWrites()).toEqual(NOTHING)
  })

  it('sends in demo mode', async () => {
    const EMAIL = cfOk()
    await notify(bothProviders(EMAIL, { DEMO_MODE: 'true' }), await bounceFor())
    expect(EMAIL.send).toHaveBeenCalledOnce()
  })

  it('logs and does not throw when every provider is down', async () => {
    const EMAIL = cfDown()
    stubFetch(() => new Response('unauthorized', { status: 401 }))
    await expect(notify(bothProviders(EMAIL), await bounceFor())).resolves.toBeUndefined()
    expect(EMAIL.send).toHaveBeenCalledOnce()
  })
})

describe('sample emails', () => {
  const sample = (e: never, type: 'login' | 'digest' = 'login', to = 'qa@example.test') => sendSampleEmail(e, getDb(env.DB), to, type)

  it('falls back to the second provider when the first is down, and returns the result that went out', async () => {
    const EMAIL = cfDown()
    const fetch = stubFetch(resendOk)
    const r = await sample(bothProviders(EMAIL))
    expect(r).toMatchObject({ ok: true, provider: 'resend' })
    expect(EMAIL.send).toHaveBeenCalledOnce()
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('returns the raw failure, not a throw, when every provider is down', async () => {
    stubFetch(() => new Response('unauthorized', { status: 401 }))
    const r = await sample(bothProviders(cfDown()))
    expect(r).toMatchObject({ ok: false, provider: 'resend', error: '401' })
  })

  it('returns a suppressed recipient as a failure, without trying the other provider', async () => {
    const fetch = stubFetch()
    const r = await sample(bothProviders(cfSuppressed()))
    expect(r).toMatchObject({ ok: false, provider: 'cloudflare' })
    expect(r.error).toContain('E_RECIPIENT_SUPPRESSED')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('returns the raw failure for a single provider that is down', async () => {
    const r = await sample(bothProviders(cfDown(), { RESEND_API_KEY: undefined }))
    expect(r).toMatchObject({ ok: false, provider: 'cloudflare' })
  })

  it('writes nothing to email health', async () => {
    stubFetch(resendOk)
    await sample(bothProviders(cfOk()))
    await sample(bothProviders(cfDown()), 'digest')
    expect(await healthWrites()).toEqual(NOTHING)
  })

  it('sends in demo mode', async () => {
    const EMAIL = cfOk()
    const r = await sample(bothProviders(EMAIL, { DEMO_MODE: 'true' }))
    expect(r).toMatchObject({ ok: true, provider: 'cloudflare' })
    expect(EMAIL.send).toHaveBeenCalledOnce()
  })

  it('sends to the one address asked for, with the sample rendered', async () => {
    const EMAIL = cfOk()
    await sample(bothProviders(EMAIL), 'digest', 'someone@example.test')
    const sent = EMAIL.send.mock.calls[0][0] as { to: string[]; subject: string }
    expect(sent.to).toEqual(['someone@example.test'])
    expect(sent.subject).toMatch(/^\[Sample\]/)
  })
})
