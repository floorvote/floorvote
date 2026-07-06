import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { activeProvider, sendEmail, sendBatch, sendMagicLink } from '../../src/lib/email'

const DEFAULT_FROM = 'FloorVote <notifications@example.com>'
const DEFAULT_REPLY_TO = 'notifications@example.com'
import { resetDb, applyMigrations } from '../helpers'
import { getDb } from '../../src/db/client'

afterEach(() => vi.unstubAllGlobals())

const baseEnv = { RESEND_API_KEY: 'k' } as any

describe('activeProvider', () => {
  it('defaults to resend when EMAIL_PROVIDER is unset', () => {
    expect(activeProvider({} as any)).toBe('resend')
  })
  it('returns cloudflare only when EMAIL_PROVIDER=cloudflare AND binding present', () => {
    expect(activeProvider({ EMAIL_PROVIDER: 'cloudflare', EMAIL: {} } as any)).toBe('cloudflare')
  })
  it('falls back to resend when cloudflare selected but binding missing', () => {
    expect(activeProvider({ EMAIL_PROVIDER: 'cloudflare' } as any)).toBe('resend')
  })
})

describe('sendEmail (resend path)', () => {
  it('POSTs /emails with defaulted from + reply_to', async () => {
    const calls: any[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => { calls.push({ url, body: JSON.parse(init.body) }); return new Response('{}', { status: 200 }) }))
    const r = await sendEmail(baseEnv, { to: ['a@e.com'], subject: 's', html: 'h' })
    expect(r).toEqual({ ok: true, provider: 'resend' })
    expect(calls[0].url).toContain('/emails')
    expect(calls[0].body.from).toBe(DEFAULT_FROM)
    expect(calls[0].body.reply_to).toBe(DEFAULT_REPLY_TO)
    expect(calls[0].body.to).toEqual(['a@e.com'])
  })
  it('returns ok:false (does not throw) on non-ok response', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn(async () => new Response('rate limited', { status: 429 })))
    const r = await sendEmail(baseEnv, { to: ['a@e.com'], subject: 's', html: 'h' })
    expect(r.ok).toBe(false)
    expect(r.provider).toBe('resend')
  })
  it('still sends in DEMO_MODE (auth/transactional must not be suppressed)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })))
    const r = await sendEmail({ ...baseEnv, DEMO_MODE: 'true' }, { to: ['a@e.com'], subject: 's', html: 'h' })
    expect(r).toEqual({ ok: true, provider: 'resend' })
  })
})

describe('sendEmail (cloudflare path)', () => {
  it('calls env.EMAIL.send with mapped fields', async () => {
    const send = vi.fn(async () => undefined)
    const env = { EMAIL_PROVIDER: 'cloudflare', EMAIL: { send } } as any
    const r = await sendEmail(env, { to: ['a@e.com'], subject: 's', html: 'h' })
    expect(r).toEqual({ ok: true, provider: 'cloudflare' })
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ to: ['a@e.com'], from: DEFAULT_FROM, replyTo: DEFAULT_REPLY_TO, subject: 's', html: 'h' }))
  })
  it('returns ok:false when the binding throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const env = { EMAIL_PROVIDER: 'cloudflare', EMAIL: { send: vi.fn(async () => { throw new Error('boom') }) } } as any
    const r = await sendEmail(env, { to: ['a@e.com'], subject: 's', html: 'h' })
    expect(r.ok).toBe(false)
    expect(r.provider).toBe('cloudflare')
  })
})

describe('sendBatch', () => {
  it('loops sendEmail per message and returns counts', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })))
    const msgs = Array.from({ length: 3 }, (_, i) => ({ to: [`u${i}@e.com`], subject: 's', html: 'h' }))
    const r = await sendBatch(baseEnv, msgs)
    expect(r).toEqual({ sent: 3, failed: 0 })
  })
  it('suppresses all sends in DEMO_MODE', async () => {
    const f = vi.fn(); vi.stubGlobal('fetch', f)
    const r = await sendBatch({ ...baseEnv, DEMO_MODE: 'true' }, [{ to: ['a@e.com'], subject: 's', html: 'h' }])
    expect(r).toEqual({ sent: 0, failed: 0 })
    expect(f).not.toHaveBeenCalled()
  })
  it('sends a batch larger than the concurrency window (chunks across rounds)', async () => {
    const f = vi.fn(async () => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', f)
    const msgs = Array.from({ length: 20 }, (_, i) => ({ to: [`u${i}@e.com`], subject: 's', html: 'h' }))
    const r = await sendBatch(baseEnv, msgs)
    expect(r).toEqual({ sent: 20, failed: 0 })
    expect(f).toHaveBeenCalledTimes(20)
  })
  it('counts failures without aborting the loop', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    let n = 0
    vi.stubGlobal('fetch', vi.fn(async () => { n++; return new Response('', { status: n === 1 ? 500 : 200 }) }))
    const r = await sendBatch(baseEnv, [{ to: ['a@e.com'], subject: 's', html: 'h' }, { to: ['b@e.com'], subject: 's', html: 'h' }])
    expect(r).toEqual({ sent: 1, failed: 1 })
  })
})

describe('sendMagicLink invite — org_noun fallback', () => {
  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
  })

  it('uses org_noun from config for invite body when no association_name is set', async () => {
    const db = getDb(env.DB)
    // Clear the association_name seeded by the initial migration so the org_noun fallback is exercised
    await env.DB.prepare(`DELETE FROM association_config WHERE key = 'association_name'`).run()
    // Seed org_noun = 'coalition'
    await env.DB.prepare(`INSERT OR REPLACE INTO association_config (key, value) VALUES ('org_noun', ?)`).bind(JSON.stringify('coalition')).run()

    const captured: { html: string; text: string }[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: any) => {
      const body = JSON.parse(init.body)
      captured.push({ html: body.html ?? '', text: body.text ?? '' })
      return new Response('{}', { status: 200 })
    }))

    await sendMagicLink(
      'invitee@example.com',
      'http://localhost:5173/auth/verify?token=abc',
      { ...env, RESEND_API_KEY: 'test-key', APP_URL: 'http://localhost:5173', ASSOCIATION_NAME: '' } as any,
      'invite',
      db,
    )

    expect(captured).toHaveLength(1)
    expect(captured[0].html).toContain('your coalition')
    expect(captured[0].html).not.toContain('your association')
    expect(captured[0].text).toContain('your coalition')
    expect(captured[0].text).not.toContain('your association')
  })
})
