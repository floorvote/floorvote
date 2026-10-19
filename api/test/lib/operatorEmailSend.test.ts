import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { env } from 'cloudflare:test'
import { clearDb, seedUser } from '../helpers'
import { getDb } from '../../src/db/client'
import { associationConfig, emailSendStats } from '../../src/db/schema'
import { reportJobFailure } from '../../src/lib/jobAlert'
import { notifyInviteBounces } from '../../src/lib/inviteBounceEmail'
import { sendSampleEmail } from '../../src/lib/sampleEmails'
import { fakeBinding, stubResend } from '../../../shared/emailTestKit'

// Operator mail (job alerts, invite-bounce notices, and sample emails, #709)
// sent through the real sender and real adapters, with the Cloudflare binding
// and `fetch` (Resend) faked at the transport. It falls back when the first
// provider is down, writes nothing to email health (no `email_send_stats` row
// and no Resend usage reading), and sends in demo mode. Feedback, the fourth
// kind, is tested at its route (test/routes/feedback.test.ts).

/** Both providers configured, the binding first. Resend is the one a fallback would reach. */
const bothProviders = (binding: unknown, extra: Record<string, unknown> = {}) => ({
  ...env, EMAIL_PROVIDER: 'cloudflare', EMAIL: binding, RESEND_API_KEY: 'test-api-key',
  APP_URL: 'https://ut.example.test', EMAIL_FROM: 'notifications@example.test',
  ALERT_EMAILS: 'ops@example.test',
  ...extra,
}) as never

// Resend's quota headers: a counted send would store them as a usage reading, so an operator send must not.
const QUOTA = { 'x-resend-monthly-quota': '812', 'x-resend-daily-quota': '40' }
const unauthorized = { status: 401, body: 'unauthorized' }

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
  await clearDb()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('job alerts', () => {
  const fail = (e: never) => reportJobFailure(e, { job: 'digest', error: new Error('boom') })

  it('falls back to the second provider when the first is down', async () => {
    const cf = fakeBinding('down')
    const resend = stubResend('ok', { headers: QUOTA })
    await fail(bothProviders(cf.binding))
    expect(cf.sent).toHaveLength(1)
    expect(resend.calls).toHaveLength(1)
    expect(resend.calls[0].body.to).toEqual(['ops@example.test'])
    expect(resend.calls[0].body.subject).toContain('cron failed: digest')
  })

  it('sends through the first provider alone when it works', async () => {
    const cf = fakeBinding('ok')
    const resend = stubResend()
    await fail(bothProviders(cf.binding))
    expect(cf.sent).toHaveLength(1)
    expect(resend.calls).toHaveLength(0)
  })

  it('writes nothing to email health, whether it went out first time or by fallback', async () => {
    stubResend('ok', { headers: QUOTA })
    await fail(bothProviders(fakeBinding('ok').binding))
    await fail(bothProviders(fakeBinding('down').binding))
    expect(await healthWrites()).toEqual(NOTHING)
  })

  it('sends in demo mode', async () => {
    const cf = fakeBinding('ok')
    await fail(bothProviders(cf.binding, { DEMO_MODE: 'true' }))
    expect(cf.sent).toHaveLength(1)
  })

  it('does not throw when every provider is down, and says so in the log', async () => {
    const cf = fakeBinding('down')
    stubResend('down', unauthorized)
    await expect(fail(bothProviders(cf.binding))).resolves.toBeUndefined()
    expect(cf.sent).toHaveLength(1)
  })

  it('makes one attempt and does not throw with only one provider configured and down', async () => {
    const cf = fakeBinding('down')
    await expect(fail(bothProviders(cf.binding, { RESEND_API_KEY: undefined }))).resolves.toBeUndefined()
    expect(cf.sent).toHaveLength(1)
  })
})

// Through the real sender, which rejects a whole message over one malformed
// address: before #781, one typo in ALERT_EMAILS blocked the alert to the good
// addresses too.
describe('job alerts: a malformed ALERT_EMAILS entry', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>
  beforeEach(() => { errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {}) })
  const fail = (e: never) => reportJobFailure(e, { job: 'digest', error: new Error('boom') })
  const logged = () => errorSpy.mock.calls.map(c => c.map(String).join(' ')).join('\n')

  it('still reaches the valid address, through the first provider, and logs the invalid entry', async () => {
    const cf = fakeBinding('ok')
    const resend = stubResend()
    await fail(bothProviders(cf.binding, { ALERT_EMAILS: 'ops@example.test, not-an-address' }))
    expect(cf.sent).toHaveLength(1)
    expect(cf.sent[0].to).toEqual(['ops@example.test'])
    expect(resend.calls).toHaveLength(0)
    expect(logged()).toContain('not-an-address')
  })

  it('still falls back to the second provider for the valid address when the first is down', async () => {
    const cf = fakeBinding('down')
    const resend = stubResend('ok', { headers: QUOTA })
    await fail(bothProviders(cf.binding, { ALERT_EMAILS: 'oops, ops@example.test, ops2@example.test' }))
    expect(resend.calls).toHaveLength(1)
    expect(resend.calls[0].body.to).toEqual(['ops@example.test', 'ops2@example.test'])
  })

  it('calls no provider, does not throw, and logs the entries and that no alert went out, when every entry is invalid', async () => {
    const cf = fakeBinding('ok')
    const resend = stubResend()
    await expect(fail(bothProviders(cf.binding, { ALERT_EMAILS: 'oops, also@oops' }))).resolves.toBeUndefined()
    expect(cf.sent).toHaveLength(0)
    expect(resend.calls).toHaveLength(0)
    expect(logged()).toContain('also@oops')
    expect(logged()).toContain('no alert sent')
  })

  it('writes nothing to email health when it sends to the valid address', async () => {
    stubResend('ok', { headers: QUOTA })
    await fail(bothProviders(fakeBinding('ok').binding, { ALERT_EMAILS: 'ops@example.test, oops' }))
    expect(await healthWrites()).toEqual(NOTHING)
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
    const cf = fakeBinding('down')
    const resend = stubResend('ok', { headers: QUOTA })
    await notify(bothProviders(cf.binding), await bounceFor())
    expect(cf.sent).toHaveLength(1)
    expect(resend.calls).toHaveLength(1)
    expect(resend.calls[0].body.to).toEqual(['admin@example.test'])
    expect(resend.calls[0].body.subject).toContain("couldn't be delivered")
  })

  it('is no longer counted toward email health, even with a db', async () => {
    stubResend('ok', { headers: QUOTA })
    await notify(bothProviders(fakeBinding('ok').binding), await bounceFor('admin-a@example.test', 'typo-a@example.test'))
    expect(await healthWrites()).toEqual(NOTHING)
  })

  it('is no longer counted toward email health when fallback rescued it, neither the failed attempt nor the rescue', async () => {
    stubResend('ok', { headers: QUOTA })
    await notify(bothProviders(fakeBinding('down').binding), await bounceFor('admin-b@example.test', 'typo-b@example.test'))
    expect(await healthWrites()).toEqual(NOTHING)
  })

  it('sends in demo mode', async () => {
    const cf = fakeBinding('ok')
    await notify(bothProviders(cf.binding, { DEMO_MODE: 'true' }), await bounceFor())
    expect(cf.sent).toHaveLength(1)
  })

  it('logs and does not throw when every provider is down', async () => {
    const cf = fakeBinding('down')
    stubResend('down', unauthorized)
    await expect(notify(bothProviders(cf.binding), await bounceFor())).resolves.toBeUndefined()
    expect(cf.sent).toHaveLength(1)
  })
})

describe('sample emails', () => {
  const sample = (e: never, type: 'login' | 'digest' = 'login', to = 'qa@example.test') => sendSampleEmail(e, getDb(env.DB), to, type)

  it('falls back to the second provider when the first is down, and returns the result that went out', async () => {
    const cf = fakeBinding('down')
    const resend = stubResend('ok', { headers: QUOTA })
    const r = await sample(bothProviders(cf.binding))
    expect(r).toMatchObject({ ok: true, provider: 'resend' })
    expect(cf.sent).toHaveLength(1)
    expect(resend.calls).toHaveLength(1)
  })

  it('returns the raw failure, not a throw, when every provider is down', async () => {
    stubResend('down', unauthorized)
    const r = await sample(bothProviders(fakeBinding('down').binding))
    expect(r).toMatchObject({ ok: false, provider: 'resend', error: '401' })
  })

  it('returns a suppressed recipient as a failure, without trying the other provider', async () => {
    const resend = stubResend()
    const r = await sample(bothProviders(fakeBinding('suppressed').binding))
    expect(r).toMatchObject({ ok: false, provider: 'cloudflare' })
    expect(r.ok ? '' : r.error).toContain('E_RECIPIENT_SUPPRESSED')
    expect(resend.calls).toHaveLength(0)
  })

  it('returns the raw failure for a single provider that is down', async () => {
    const r = await sample(bothProviders(fakeBinding('down').binding, { RESEND_API_KEY: undefined }))
    expect(r).toMatchObject({ ok: false, provider: 'cloudflare' })
  })

  it('writes nothing to email health', async () => {
    stubResend('ok', { headers: QUOTA })
    await sample(bothProviders(fakeBinding('ok').binding))
    await sample(bothProviders(fakeBinding('down').binding), 'digest')
    expect(await healthWrites()).toEqual(NOTHING)
  })

  it('sends in demo mode', async () => {
    const cf = fakeBinding('ok')
    const r = await sample(bothProviders(cf.binding, { DEMO_MODE: 'true' }))
    expect(r).toMatchObject({ ok: true, provider: 'cloudflare' })
    expect(cf.sent).toHaveLength(1)
  })

  it('sends to the one address asked for, with the sample rendered', async () => {
    const cf = fakeBinding('ok')
    await sample(bothProviders(cf.binding), 'digest', 'someone@example.test')
    expect(cf.sent[0].to).toEqual(['someone@example.test'])
    expect(cf.sent[0].subject).toMatch(/^\[Sample\]/)
  })
})
