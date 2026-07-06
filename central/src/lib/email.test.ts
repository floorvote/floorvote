import { describe, it, expect, vi, afterEach } from 'vitest'
import { sendEmail } from './email'

type Sent = Record<string, unknown>

function fakeCfEnv(onSend: (msg: Sent) => unknown) {
  const sent: Sent[] = []
  const env = {
    EMAIL_PROVIDER: 'cloudflare' as const,
    EMAIL: { send: async (msg: Sent) => { sent.push(msg); return onSend(msg) } },
  }
  return { env, sent }
}

describe('sendEmail — Cloudflare binding', () => {
  it('derives a plain-text part from the html when none is provided', async () => {
    const { env, sent } = fakeCfEnv(() => ({ messageId: 'm1' }))
    const r = await sendEmail(env as never, { to: ['a@b.com'], subject: 'Hi', html: '<p>Hello <b>there</b></p>' })
    expect(r.ok).toBe(true)
    expect(sent[0].text).toBe('Hello there')
  })

  it('keeps an explicit text part instead of deriving one', async () => {
    const { env, sent } = fakeCfEnv(() => ({ messageId: 'm1' }))
    await sendEmail(env as never, { to: ['a@b.com'], subject: 'Hi', html: '<p>Hello</p>', text: 'hand-written' })
    expect(sent[0].text).toBe('hand-written')
  })

  it('forwards custom headers', async () => {
    const { env, sent } = fakeCfEnv(() => ({ messageId: 'm1' }))
    const headers = { 'List-Unsubscribe': '<https://x.test/profile>' }
    await sendEmail(env as never, { to: ['a@b.com'], subject: 'Hi', html: '<p>x</p>', headers })
    expect(sent[0].headers).toEqual(headers)
  })

  it('captures the thrown error.code in the failure result', async () => {
    const err = Object.assign(new Error('rate limited'), { code: 'E_RATE_LIMIT_EXCEEDED' })
    const { env } = fakeCfEnv(() => { throw err })
    const r = await sendEmail(env as never, { to: ['a@b.com'], subject: 'Hi', html: '<p>x</p>' })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('E_RATE_LIMIT_EXCEEDED')
  })
})

describe('sendEmail — Resend', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('includes the derived text in the Resend payload', async () => {
    let body: Record<string, unknown> = {}
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      body = JSON.parse(init.body as string)
      return new Response(null, { status: 200 })
    }))
    const env = { RESEND_API_KEY: 'k', EMAIL_PROVIDER: 'resend' as const }
    const r = await sendEmail(env as never, { to: ['a@b.com'], subject: 'Hi', html: '<p>Hello</p>' })
    expect(r.ok).toBe(true)
    expect(body.text).toBe('Hello')
  })
})
