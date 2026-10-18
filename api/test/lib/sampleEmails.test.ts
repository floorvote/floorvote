import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { env, createExecutionContext } from 'cloudflare:test'
import { resetDb, applyMigrations, stubFetch } from '../helpers'
import app from '../../src/index'
import { CentralApi } from '../../src/centralApi'
import { getDb } from '../../src/db/client'
import { emailSendStats } from '../../src/db/schema'
import { sendSampleEmail } from '../../src/lib/sampleEmails'

describe('sendSampleEmail', () => {
  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
  })

  it('does not count toward email_send_stats, so a sample cannot mask a failing provider', async () => {
    const send = vi.fn(async () => ({ messageId: 'cf-1' }))
    const e = { ...env, EMAIL_PROVIDER: 'cloudflare', EMAIL: { send }, APP_URL: 'https://ut.example.test', EMAIL_FROM: 'n@example.test' }
    const db = getDb(env.DB)
    const r = await sendSampleEmail(e as never, db, 'qa@example.test', 'login')
    expect(r.ok).toBe(true)
    expect(send).toHaveBeenCalledOnce()
    expect(await db.select().from(emailSendStats).all()).toHaveLength(0)
  })
})

// The sample email's result goes back to whoever asked for it, as the sender
// returned it: over HTTP (the internal route) and over RPC (central's operator
// route). A failure is a result, never a throw, and a fallback shows up in it
// as the provider that actually sent (#709).
describe('the sample email result, at the HTTP route and the RPC', () => {
  const cfDown = () => ({ send: vi.fn(async () => { throw Object.assign(new Error('down'), { code: 'E_INTERNAL_SERVER_ERROR' }) }) })
  const cfOk = () => ({ send: vi.fn(async () => ({ messageId: 'cf-1' })) })
  const sampleEnv = (EMAIL: unknown, extra: Record<string, unknown> = {}) => ({
    ...env, CENTRAL_ADMIN_SECRET: 'sek', EMAIL_PROVIDER: 'cloudflare', EMAIL, RESEND_API_KEY: 'test-api-key',
    APP_URL: 'https://ut.example.test', EMAIL_FROM: 'n@example.test', ...extra,
  }) as never
  const post = (e: never, body: unknown) => app.fetch(new Request('http://t/api/internal/send-sample-email', {
    method: 'POST', headers: { 'x-admin-secret': 'sek', 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }), e)

  beforeEach(async () => {
    await resetDb(); await applyMigrations()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

  it('HTTP: answers 200 with the provider that sent it when the first provider is down and fallback rescues it', async () => {
    stubFetch(() => new Response(JSON.stringify({ id: 'rs-1' }), { status: 200 }))
    const res = await post(sampleEnv(cfDown()), { to: 'qa@example.test', type: 'login' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, type: 'login', to: 'qa@example.test', provider: 'resend' })
  })

  it('HTTP: answers 502 with the failing provider and its error when both are down', async () => {
    stubFetch(() => new Response('unauthorized', { status: 401 }))
    const res = await post(sampleEnv(cfDown()), { to: 'qa@example.test', type: 'login' })
    expect(res.status).toBe(502)
    expect(await res.json()).toMatchObject({ ok: false, type: 'login', to: 'qa@example.test', provider: 'resend', error: '401' })
  })

  it('HTTP: answers 200 through the first provider alone when it works', async () => {
    const EMAIL = cfOk()
    const fetch = stubFetch()
    const res = await post(sampleEnv(EMAIL), { to: 'qa@example.test', type: 'digest' })
    expect(await res.json()).toMatchObject({ ok: true, provider: 'cloudflare' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('HTTP: sends in demo mode', async () => {
    const EMAIL = cfOk()
    const res = await post(sampleEnv(EMAIL, { DEMO_MODE: 'true' }), { to: 'qa@example.test', type: 'login' })
    expect(res.status).toBe(200)
    expect(EMAIL.send).toHaveBeenCalledOnce()
  })

  it('RPC: returns the result with the provider that sent it after a fallback', async () => {
    stubFetch(() => new Response(JSON.stringify({ id: 'rs-1' }), { status: 200 }))
    const entry = new CentralApi(createExecutionContext(), sampleEnv(cfDown()))
    expect(await entry.sendSampleEmail('qa@example.test', 'reply')).toMatchObject({ ok: true, provider: 'resend' })
  })

  it('RPC: returns the failure, not a throw, when both providers are down', async () => {
    stubFetch(() => new Response('unauthorized', { status: 401 }))
    const entry = new CentralApi(createExecutionContext(), sampleEnv(cfDown()))
    expect(await entry.sendSampleEmail('qa@example.test', 'mention')).toMatchObject({ ok: false, provider: 'resend', error: '401' })
  })

  it('RPC: returns each attempt that was made, so the operator can see the fallback', async () => {
    stubFetch(() => new Response(JSON.stringify({ id: 'rs-1' }), { status: 200 }))
    const entry = new CentralApi(createExecutionContext(), sampleEnv(cfDown()))
    const r = await entry.sendSampleEmail('qa@example.test', 'login') as { attempts?: { provider: string; ok: boolean }[] }
    expect(r.attempts?.map(a => `${a.provider}:${a.ok}`)).toEqual(['cloudflare:false', 'resend:true'])
  })
})
