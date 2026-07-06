import { describe, it, expect, vi, afterEach } from 'vitest'
import { activeProvider, sendEmail } from '../../src/lib/email'

const DEFAULT_FROM = 'FloorVote <notifications@example.com>'
const DEFAULT_REPLY_TO = 'notifications@example.com'

afterEach(() => vi.unstubAllGlobals())

describe('central activeProvider', () => {
  it('defaults to resend', () => expect(activeProvider({} as any)).toBe('resend'))
  it('cloudflare when selected + binding present', () => expect(activeProvider({ EMAIL_PROVIDER: 'cloudflare', EMAIL: {} } as any)).toBe('cloudflare'))
  it('falls back to resend when cloudflare selected but binding missing', () => expect(activeProvider({ EMAIL_PROVIDER: 'cloudflare' } as any)).toBe('resend'))
})

describe('central sendEmail', () => {
  it('resend path posts /emails with defaults', async () => {
    const calls: any[] = []
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: any) => { calls.push(JSON.parse(init.body)); return new Response('{}', { status: 200 }) }))
    const r = await sendEmail({ RESEND_API_KEY: 'k' } as any, { to: ['a@e.com'], subject: 's', html: 'h' })
    expect(r.ok).toBe(true)
    expect(calls[0].from).toBe(DEFAULT_FROM)
    expect(calls[0].reply_to).toBe(DEFAULT_REPLY_TO)
  })
  it('cloudflare path calls env.EMAIL.send', async () => {
    const send = vi.fn(async () => undefined)
    const r = await sendEmail({ EMAIL_PROVIDER: 'cloudflare', EMAIL: { send } } as any, { to: ['a@e.com'], subject: 's', html: 'h' })
    expect(r.ok).toBe(true)
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ to: ['a@e.com'], from: DEFAULT_FROM }))
  })
  it('returns ok:false when the binding throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const r = await sendEmail({ EMAIL_PROVIDER: 'cloudflare', EMAIL: { send: vi.fn(async () => { throw new Error('cf-boom') }) } } as any, { to: ['a@e.com'], subject: 's', html: 'h' })
    expect(r.ok).toBe(false)
    expect(r.provider).toBe('cloudflare')
  })

  it('uses EMAIL_FROM / EMAIL_REPLY_TO when set (resend path)', async () => {
    const calls: any[] = []
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: any) => { calls.push(JSON.parse(init.body)); return new Response('{}', { status: 200 }) }))
    await sendEmail({ RESEND_API_KEY: 'k', EMAIL_FROM: 'alerts@example.org', EMAIL_REPLY_TO: 'replies@example.org' } as any, { to: ['a@e.com'], subject: 's', html: 'h' })
    expect(calls[0].from).toBe('FloorVote <alerts@example.org>')
    expect(calls[0].reply_to).toBe('replies@example.org')
  })

  it('reply_to defaults to EMAIL_FROM when EMAIL_REPLY_TO is unset', async () => {
    const calls: any[] = []
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: any) => { calls.push(JSON.parse(init.body)); return new Response('{}', { status: 200 }) }))
    await sendEmail({ RESEND_API_KEY: 'k', EMAIL_FROM: 'alerts@example.org' } as any, { to: ['a@e.com'], subject: 's', html: 'h' })
    expect(calls[0].from).toBe('FloorVote <alerts@example.org>')
    expect(calls[0].reply_to).toBe('alerts@example.org')
  })
})
