import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { env } from 'cloudflare:test'
import { resetDb, applyMigrations, stubFetch } from '../helpers'
import { getDb } from '../../src/db/client'
import { associationConfig, authEvents, emailSendStats } from '../../src/db/schema'
import { sendMagicLink } from '../../src/lib/email'
import { PermanentSendError } from '../../src/lib/emailErrors'

// Sign-in emails through the shared sender, at the API's seam: sendMagicLink
// with a real D1, a fake send_email binding, and a stubbed fetch for Resend.
// These pin the behavior the move must keep.

const baseEnv = (overrides: Record<string, unknown> = {}) => ({
  APP_URL: 'http://localhost', DEMO_MODE: 'false', ASSOCIATION_NAME: 'Test Team',
  EMAIL_FROM: 'notifications@example.com',
  ...overrides,
}) as never

const cfThrows = (code: string) => ({ send: vi.fn(async () => { throw Object.assign(new Error(code.toLowerCase()), { code }) }) })
const cfOk = () => ({ send: vi.fn(async () => ({ messageId: 'cf-1' })) })

async function stats() {
  const rows = await getDb(env.DB).select().from(emailSendStats).all()
  return Object.fromEntries(rows.map(r => [r.provider, r]))
}

describe('sign-in emails', () => {
  beforeEach(async () => {
    await resetDb(); await applyMigrations()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

  it('goes out through Resend when Cloudflare is down, counting each attempt to its own provider', async () => {
    const fetch = stubFetch(() => new Response(JSON.stringify({ id: 'rs-1' }), { status: 200 }))
    const EMAIL = cfThrows('E_INTERNAL_SERVER_ERROR')
    await expect(sendMagicLink('jane@example.com', 'http://localhost/v?t=1',
      baseEnv({ EMAIL_PROVIDER: 'cloudflare', EMAIL, RESEND_API_KEY: 'test-api-key' }), 'login', getDb(env.DB), 'user-1'))
      .resolves.toBeUndefined()
    expect(EMAIL.send).toHaveBeenCalledOnce()
    expect(fetch).toHaveBeenCalledOnce()
    const by = await stats()
    expect(by.cloudflare).toMatchObject({ sent: 0, failed: 1, suppressed: 0 })
    expect(by.resend).toMatchObject({ sent: 1, failed: 0 })
  })

  it('goes out through Cloudflare when a Resend fetch throws', async () => {
    stubFetch(() => { throw new TypeError('network connection lost') })
    const EMAIL = cfOk()
    await expect(sendMagicLink('jane@example.com', 'http://localhost/v?t=1',
      baseEnv({ EMAIL_PROVIDER: 'resend', EMAIL, RESEND_API_KEY: 'test-api-key' }), 'login', getDb(env.DB), 'user-1'))
      .resolves.toBeUndefined()
    expect(EMAIL.send).toHaveBeenCalledOnce()
    const events = (await getDb(env.DB).select().from(authEvents).all()).map(r => `${r.provider}:${r.event}`)
    expect(events).toEqual(['resend:email_send_failed', 'cloudflare:email_sent'])
    const failed = (await getDb(env.DB).select().from(authEvents).all())[0]
    expect(failed.reason).toContain('fetch failed')
  })

  it('throws a retryable error, not a permanent one, when a Resend fetch throws and nothing else is configured', async () => {
    stubFetch(() => { throw new TypeError('network connection lost') })
    const err = await sendMagicLink('jane@example.com', 'http://localhost/v?t=1',
      baseEnv({ RESEND_API_KEY: 'test-api-key' }), 'invite', getDb(env.DB), 'user-1').catch(e => e)
    expect(err).toBeInstanceOf(Error)
    expect(err).not.toBeInstanceOf(PermanentSendError)
  })

  it('counts a suppressed recipient as suppressed and throws permanent without trying Resend', async () => {
    const fetch = stubFetch()
    await expect(sendMagicLink('jane@example.com', 'http://localhost/v?t=1',
      baseEnv({ EMAIL_PROVIDER: 'cloudflare', EMAIL: cfThrows('E_RECIPIENT_SUPPRESSED'), RESEND_API_KEY: 'test-api-key' }), 'invite', getDb(env.DB), 'user-1'))
      .rejects.toBeInstanceOf(PermanentSendError)
    expect(fetch).not.toHaveBeenCalled()
    expect((await stats()).cloudflare).toMatchObject({ sent: 0, failed: 0, suppressed: 1 })
  })

  it('throws permanent for an invalid address, calling no provider and counting nothing', async () => {
    const fetch = stubFetch()
    const EMAIL = cfOk()
    await expect(sendMagicLink('jane@example.gov;', 'http://localhost/v?t=1',
      baseEnv({ EMAIL_PROVIDER: 'cloudflare', EMAIL, RESEND_API_KEY: 'test-api-key' }), 'invite', getDb(env.DB), 'user-1'))
      .rejects.toBeInstanceOf(PermanentSendError)
    expect(EMAIL.send).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
    expect(await getDb(env.DB).select().from(emailSendStats).all()).toHaveLength(0)
    const [row] = await getDb(env.DB).select().from(authEvents).all()
    expect(row).toMatchObject({ event: 'email_send_failed', provider: null, reason: 'invalid recipient address; not sent', linkType: 'invite', userId: 'user-1' })
  })

  it('in demo mode, suppresses an invite without an event or a throw', async () => {
    const EMAIL = cfOk()
    await expect(sendMagicLink('jane@example.com', 'http://localhost/v?t=1',
      baseEnv({ DEMO_MODE: 'true', EMAIL_PROVIDER: 'cloudflare', EMAIL }), 'invite', getDb(env.DB), 'user-1'))
      .resolves.toBeUndefined()
    expect(EMAIL.send).not.toHaveBeenCalled()
    expect(await getDb(env.DB).select().from(authEvents).all()).toHaveLength(0)
  })

  it('in demo mode, sends a login link and records it', async () => {
    const EMAIL = cfOk()
    await sendMagicLink('jane@example.com', 'http://localhost/v?t=1',
      baseEnv({ DEMO_MODE: 'true', EMAIL_PROVIDER: 'cloudflare', EMAIL }), 'login', getDb(env.DB), 'user-1')
    expect(EMAIL.send).toHaveBeenCalledOnce()
    const [row] = await getDb(env.DB).select().from(authEvents).all()
    expect(row).toMatchObject({ event: 'email_sent', provider: 'cloudflare', messageId: 'cf-1', linkType: 'login' })
  })

  it('without a db, sends and counts nothing', async () => {
    const EMAIL = cfOk()
    await sendMagicLink('jane@example.com', 'http://localhost/v?t=1', baseEnv({ EMAIL_PROVIDER: 'cloudflare', EMAIL }), 'login')
    expect(EMAIL.send).toHaveBeenCalledOnce()
    expect(await getDb(env.DB).select().from(emailSendStats).all()).toHaveLength(0)
  })

  it('records Resend usage from a Resend send', async () => {
    stubFetch(() => new Response(JSON.stringify({ id: 'rs-1' }), { status: 200, headers: { 'x-resend-monthly-quota': '41' } }))
    await sendMagicLink('jane@example.com', 'http://localhost/v?t=1', baseEnv({ RESEND_API_KEY: 'test-api-key' }), 'login', getDb(env.DB), 'user-1')
    const rows = await getDb(env.DB).select().from(associationConfig).all()
    expect(rows.find(r => r.key === 'resend_monthly_used')?.value).toBe('41')
  })

  it('names the association from its config row in an invite', async () => {
    const db = getDb(env.DB)
    await db.insert(associationConfig).values({ key: 'association_name', value: JSON.stringify('Sample Coalition') })
      .onConflictDoUpdate({ target: associationConfig.key, set: { value: JSON.stringify('Sample Coalition') } })
    const EMAIL = { send: vi.fn(async (_m: Record<string, unknown>) => ({ messageId: 'cf-1' })) }
    await sendMagicLink('jane@example.com', 'http://localhost/v?t=1',
      baseEnv({ EMAIL_PROVIDER: 'cloudflare', EMAIL, ASSOCIATION_NAME: 'Env Name' }), 'invite', db, 'user-1')
    const sent = EMAIL.send.mock.calls[0][0]
    expect(String(sent.text)).toContain('Sample Coalition')
    expect(String(sent.subject)).toBe("You've been invited to FloorVote")
  })
})
