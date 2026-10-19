import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { env } from 'cloudflare:test'
import { resetDb, applyMigrations } from '../helpers'
import { getDb } from '../../src/db/client'
import { associationConfig, authEvents, emailSendStats } from '../../src/db/schema'
import { sendSignInLink, sendSignInLinkLogged } from '../../src/lib/signInLink'
import { buildSignInMessage } from '../../src/lib/email'
import { fakeBinding, stubResend } from '../../../shared/emailTestKit'

// Sign-in emails through the shared sender, at the API's seam: sendSignInLink
// with a real D1, a fake send_email binding, and a faked Resend. These pin the
// wiring the sender can't know: the health recorder behind `email_send_stats`
// and the Resend usage readout, the `auth_events` rows, and the association
// name and org noun read from config. The sender's own rules (fallback, the
// address check, demo mode) are covered by shared/emailSender.test.ts.

const baseEnv = (overrides: Record<string, unknown> = {}) => ({
  APP_URL: 'http://localhost', DEMO_MODE: 'false', ASSOCIATION_NAME: 'Test Team',
  EMAIL_FROM: 'notifications@example.com',
  ...overrides,
}) as never

const URL_ = 'http://localhost/v?t=1'
const rateLimited = { message: 'slow down', code: 'E_RATE_LIMIT_EXCEEDED' }
const notAllowed = { message: 'not verified', code: 'E_RECIPIENT_NOT_ALLOWED' }

async function stats() {
  const rows = await getDb(env.DB).select().from(emailSendStats).all()
  return Object.fromEntries(rows.map(r => [r.provider, r]))
}
const events = async () => getDb(env.DB).select().from(authEvents).all()

beforeEach(async () => {
  await resetDb(); await applyMigrations()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

describe('fallback, and counting each attempt', () => {
  it('goes out through Resend when Cloudflare is down, counting each attempt to its own provider', async () => {
    const resend = stubResend()
    const cf = fakeBinding('down')
    const r = await sendSignInLink(baseEnv({ EMAIL_PROVIDER: 'cloudflare', EMAIL: cf.binding, RESEND_API_KEY: 'test-api-key' }), getDb(env.DB),
      { to: 'jane@example.com', link: 'login', url: URL_, userId: 'user-1' })
    expect(r).toMatchObject({ ok: true, provider: 'resend' })
    expect(cf.sent).toHaveLength(1)
    expect(resend.calls).toHaveLength(1)
    const by = await stats()
    expect(by.cloudflare).toMatchObject({ sent: 0, failed: 1, suppressed: 0 })
    expect(by.resend).toMatchObject({ sent: 1, failed: 0 })
  })

  it('goes out through Cloudflare when a Resend fetch throws, recording both halves as events', async () => {
    stubResend('throw')
    const cf = fakeBinding('ok')
    const r = await sendSignInLink(baseEnv({ EMAIL_PROVIDER: 'resend', EMAIL: cf.binding, RESEND_API_KEY: 'test-api-key' }), getDb(env.DB),
      { to: 'jane@example.com', link: 'login', url: URL_, userId: 'user-1' })
    expect(r).toMatchObject({ ok: true, provider: 'cloudflare' })
    expect(cf.sent).toHaveLength(1)
    const rows = await events()
    expect(rows.map(r => `${r.provider}:${r.event}`)).toEqual(['resend:email_send_failed', 'cloudflare:email_sent'])
    expect(rows[0].reason).toContain('fetch failed')
  })

  it('falls back to Resend and records both attempts as events when Cloudflare refuses the address as not allowed', async () => {
    stubResend()
    const cf = fakeBinding('down', notAllowed)
    const r = await sendSignInLink(baseEnv({ EMAIL_PROVIDER: 'cloudflare', EMAIL: cf.binding, RESEND_API_KEY: 'test-api-key' }), getDb(env.DB),
      { to: 'a@b.com', link: 'login', url: URL_, userId: 'user-1' })
    expect(r.ok).toBe(true)
    const rows = await events()
    expect(rows).toHaveLength(2)
    const failed = rows.find(r => r.event === 'email_send_failed')!
    const sent = rows.find(r => r.event === 'email_sent')!
    expect(failed).toMatchObject({ provider: 'cloudflare', linkType: 'login', userId: 'user-1' })
    expect(failed.reason).toContain('E_RECIPIENT_NOT_ALLOWED')
    expect(sent).toMatchObject({ provider: 'resend', messageId: 're-1', linkType: 'login', userId: 'user-1' })
  })

  it('answers with the failure, with both attempts logged, when the fallback also fails', async () => {
    stubResend('down', { status: 401, body: 'bad key' })
    const cf = fakeBinding('down', notAllowed)
    const r = await sendSignInLink(baseEnv({ EMAIL_PROVIDER: 'cloudflare', EMAIL: cf.binding, RESEND_API_KEY: 'test-api-key' }), getDb(env.DB),
      { to: 'a@b.com', link: 'invite', url: URL_, userId: 'user-1' })
    expect(r).toMatchObject({ ok: false, provider: 'resend', permanent: false })
    expect((await events()).map(r => `${r.provider}:${r.event}`).sort()).toEqual(['cloudflare:email_send_failed', 'resend:email_send_failed'])
  })

  it('answers temporary, not permanent, when a Resend fetch throws and nothing else is configured', async () => {
    stubResend('throw')
    const r = await sendSignInLink(baseEnv({ RESEND_API_KEY: 'test-api-key' }), getDb(env.DB),
      { to: 'jane@example.com', link: 'invite', url: URL_, userId: 'user-1' })
    expect(r).toMatchObject({ ok: false, permanent: false })
  })
})

describe('permanent failures', () => {
  it('counts a suppressed recipient as suppressed and answers permanent without trying Resend', async () => {
    const resend = stubResend()
    const cf = fakeBinding('suppressed')
    const r = await sendSignInLink(baseEnv({ EMAIL_PROVIDER: 'cloudflare', EMAIL: cf.binding, RESEND_API_KEY: 'test-api-key' }), getDb(env.DB),
      { to: 'jane@example.com', link: 'invite', url: URL_, userId: 'user-1' })
    expect(r).toMatchObject({ ok: false, provider: 'cloudflare', permanent: true })
    expect(resend.calls).toHaveLength(0)
    expect((await stats()).cloudflare).toMatchObject({ sent: 0, failed: 0, suppressed: 1 })
  })

  it('records a suppressed recipient as email_bounced, with the code as the reason, and no fallback', async () => {
    const resend = stubResend()
    const cf = fakeBinding('suppressed')
    await sendSignInLink(baseEnv({ EMAIL_PROVIDER: 'cloudflare', EMAIL: cf.binding, RESEND_API_KEY: 'test-api-key' }), getDb(env.DB),
      { to: 'a@b.com', link: 'login', url: URL_, userId: 'user-1' })
    expect(resend.calls).toHaveLength(0)
    const rows = await events()
    expect(rows.map(r => r.event)).toEqual(['email_bounced'])
    expect(rows[0].reason).toContain('E_RECIPIENT_SUPPRESSED')
  })

  it('answers permanent for an invalid address, calling no provider and counting nothing, with one event and no provider', async () => {
    const resend = stubResend()
    const cf = fakeBinding('ok')
    const r = await sendSignInLink(baseEnv({ EMAIL_PROVIDER: 'cloudflare', EMAIL: cf.binding, RESEND_API_KEY: 'test-api-key' }), getDb(env.DB),
      { to: 'jane@example.gov;', link: 'invite', url: URL_, userId: 'user-1' })
    expect(r).toMatchObject({ ok: false, provider: null, permanent: true })
    expect(cf.sent).toHaveLength(0)
    expect(resend.calls).toHaveLength(0)
    expect(await getDb(env.DB).select().from(emailSendStats).all()).toHaveLength(0)
    const [row] = await events()
    expect(row).toMatchObject({ event: 'email_send_failed', provider: null, reason: 'invalid recipient address; not sent', linkType: 'invite', userId: 'user-1' })
  })
})

describe('auth events', () => {
  it('records email_sent, with the message id, the member, the provider, and the link type', async () => {
    const cf = fakeBinding('ok')
    await sendSignInLink(baseEnv({ EMAIL_PROVIDER: 'cloudflare', EMAIL: cf.binding }), getDb(env.DB),
      { to: 'a@b.com', link: 'login', url: 'http://localhost/auth/verify?token=t', userId: 'user-1' })
    const [row] = await events()
    expect(row).toMatchObject({ event: 'email_sent', messageId: 'cf-1', userId: 'user-1', provider: 'cloudflare', linkType: 'login', email: 'a@b.com' })
  })

  it('records email_send_failed, with the code as the reason, for a provider error that is not about the address', async () => {
    const cf = fakeBinding('down', rateLimited)
    await sendSignInLink(baseEnv({ EMAIL_PROVIDER: 'cloudflare', EMAIL: cf.binding }), getDb(env.DB),
      { to: 'a@b.com', link: 'login', url: URL_, userId: 'user-1' })
    const [row] = await events()
    expect(row.event).toBe('email_send_failed')
    expect(row.reason).toContain('E_RATE_LIMIT_EXCEEDED')
  })

  it('attributes an event to no member when none is given', async () => {
    const cf = fakeBinding('ok')
    await sendSignInLink(baseEnv({ EMAIL_PROVIDER: 'cloudflare', EMAIL: cf.binding }), getDb(env.DB), { to: 'a@b.com', link: 'login', url: URL_ })
    const [row] = await events()
    expect(row.userId).toBeNull()
  })
})

describe('demo mode', () => {
  it('suppresses an invite without an event, and answers that it was skipped rather than failed', async () => {
    const cf = fakeBinding('ok')
    const r = await sendSignInLink(baseEnv({ DEMO_MODE: 'true', EMAIL_PROVIDER: 'cloudflare', EMAIL: cf.binding }), getDb(env.DB),
      { to: 'jane@example.com', link: 'invite', url: URL_, userId: 'user-1' })
    expect(r).toMatchObject({ ok: true, provider: null, skipped: 'demo-mode' })
    expect(cf.sent).toHaveLength(0)
    expect(await events()).toHaveLength(0)
  })

  it('sends a login link, and records it', async () => {
    const cf = fakeBinding('ok')
    const r = await sendSignInLink(baseEnv({ DEMO_MODE: 'true', EMAIL_PROVIDER: 'cloudflare', EMAIL: cf.binding }), getDb(env.DB),
      { to: 'ops@e.com', link: 'login', url: URL_, userId: 'user-1' })
    expect(r.ok).toBe(true)
    expect(cf.sent).toHaveLength(1)
    const [row] = await events()
    expect(row).toMatchObject({ event: 'email_sent', provider: 'cloudflare', messageId: 'cf-1', linkType: 'login' })
  })
})

describe('what it reads from config', () => {
  it('records Resend usage from a Resend send', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify({ id: 'rs-1' }), { status: 200, headers: { 'x-resend-monthly-quota': '41' } }))
    await sendSignInLink(baseEnv({ RESEND_API_KEY: 'test-api-key' }), getDb(env.DB), { to: 'jane@example.com', link: 'login', url: URL_, userId: 'user-1' })
    const rows = await getDb(env.DB).select().from(associationConfig).all()
    expect(rows.find(r => r.key === 'resend_monthly_used')?.value).toBe('41')
  })

  it('names the association from its config row in an invite, ahead of the env name', async () => {
    const db = getDb(env.DB)
    await db.insert(associationConfig).values({ key: 'association_name', value: JSON.stringify('Sample Coalition') })
      .onConflictDoUpdate({ target: associationConfig.key, set: { value: JSON.stringify('Sample Coalition') } })
    const cf = fakeBinding('ok')
    await sendSignInLink(baseEnv({ EMAIL_PROVIDER: 'cloudflare', EMAIL: cf.binding, ASSOCIATION_NAME: 'Env Name' }), db,
      { to: 'jane@example.com', link: 'invite', url: URL_, userId: 'user-1' })
    expect(String(cf.sent[0].text)).toContain('Sample Coalition')
    expect(cf.sent[0].subject).toBe("You've been invited to FloorVote")
  })

  it('names the association from the env when there is no config row', async () => {
    await env.DB.prepare(`DELETE FROM association_config WHERE key = 'association_name'`).run()
    const cf = fakeBinding('ok')
    await sendSignInLink(baseEnv({ EMAIL_PROVIDER: 'cloudflare', EMAIL: cf.binding, ASSOCIATION_NAME: 'RI Clerks' }), getDb(env.DB),
      { to: 'a@b.com', link: 'invite', url: 'https://x.test/invite?token=xyz', userId: 'user-1' })
    expect(String(cf.sent[0].text)).toContain('RI Clerks')
    expect(String(cf.sent[0].html)).toContain('RI Clerks')
  })

  it('uses org_noun from config for the invite body when no association name is set', async () => {
    await env.DB.prepare(`DELETE FROM association_config WHERE key = 'association_name'`).run()
    await env.DB.prepare(`INSERT OR REPLACE INTO association_config (key, value) VALUES ('org_noun', ?)`).bind(JSON.stringify('coalition')).run()
    const cf = fakeBinding('ok')
    await sendSignInLink(baseEnv({ EMAIL_PROVIDER: 'cloudflare', EMAIL: cf.binding, ASSOCIATION_NAME: '' }), getDb(env.DB),
      { to: 'invitee@example.com', link: 'invite', url: 'http://localhost:5173/auth/verify?token=abc' })
    const { html, text } = cf.sent[0]
    expect(html).toContain('your coalition')
    expect(html).not.toContain('your association')
    expect(text).toContain('your coalition')
    expect(text).not.toContain('your association')
  })
})

describe('sendSignInLinkLogged', () => {
  it('logs a failed send and does not throw, for the routes that send in the background', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const cf = fakeBinding('down', rateLimited)
    await expect(sendSignInLinkLogged(baseEnv({ EMAIL_PROVIDER: 'cloudflare', EMAIL: cf.binding }), getDb(env.DB),
      { to: 'a@b.com', link: 'login', url: URL_, userId: 'user-1' })).resolves.toBeUndefined()
    expect(err.mock.calls.map(c => String(c[0]))).toContain('Email send failed (cloudflare): E_RATE_LIMIT_EXCEEDED: slow down')
  })

  it('does not throw when the send itself throws, logging that instead', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const brokenDb = { select: () => { throw new Error('D1 down') } } as never
    await expect(sendSignInLinkLogged(baseEnv({ EMAIL_PROVIDER: 'cloudflare', EMAIL: fakeBinding('ok').binding }), brokenDb,
      { to: 'a@b.com', link: 'login', url: URL_, userId: 'user-1' })).resolves.toBeUndefined()
    expect(err).toHaveBeenCalled()
  })

  it('sends quietly when it works', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const cf = fakeBinding('ok')
    await sendSignInLinkLogged(baseEnv({ EMAIL_PROVIDER: 'cloudflare', EMAIL: cf.binding }), getDb(env.DB), { to: 'a@b.com', link: 'login', url: URL_, userId: 'user-1' })
    expect(cf.sent).toHaveLength(1)
    expect(err).not.toHaveBeenCalled()
  })
})

describe('the sign-in message', () => {
  const login = () => buildSignInMessage({ to: 'a@b.com', link: 'login', magicLinkUrl: 'https://x.test/auth?token=abc', appUrl: 'https://x.test', assocName: 'RI Clerks' })
  const invite = () => buildSignInMessage({ to: 'a@b.com', link: 'invite', magicLinkUrl: 'https://x.test/invite?token=xyz', appUrl: 'https://x.test', assocName: 'RI Clerks' })

  it('puts the sign-in URL in the text part without referencing a (nonexistent) button', () => {
    const m = login()
    expect(m.text).toContain('https://x.test/auth?token=abc')
    expect(m.text!.toLowerCase()).not.toContain('button')
    expect(m.html).toContain('Sign in to FloorVote')  // button label
    expect(m.html).toContain('href="https://x.test/auth?token=abc"')
  })

  it('names the association and includes the invite URL in an invite', () => {
    const m = invite()
    expect(m.text).toContain('https://x.test/invite?token=xyz')
    expect(m.text).toContain('RI Clerks')
    // Self-recovery line: missing the invite isn't a dead end. It points at the
    // login page (APP_URL) so a spam-filtered invite is recoverable.
    expect(m.text).toContain('request a new sign-in link')
    expect(m.text).toContain('\n\nhttps://x.test\n\n')
    expect(m.html).toContain('request a new sign-in link')
    expect(m.html).toContain('href="https://x.test"')
    // The shell masthead shows the instance name, and the CTA the invite button label.
    expect(m.html).toContain('RI Clerks')
    expect(m.html).toContain('Accept your invitation')
  })

  it('is a sign-in purpose message to one recipient, with the link type the caller named', () => {
    expect(login()).toMatchObject({ purpose: 'sign-in', link: 'login', to: ['a@b.com'] })
    expect(invite()).toMatchObject({ purpose: 'sign-in', link: 'invite' })
  })
})
