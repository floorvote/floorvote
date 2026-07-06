import { describe, it, expect, vi, afterEach } from 'vitest'
import { sendEmail, sendMagicLink, unsubscribeHeaders, sendFeedback } from './email'

type Sent = Record<string, unknown>

// Minimal fake of the Cloudflare send_email binding that records what it received.
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

  it('forwards custom headers (e.g. List-Unsubscribe)', async () => {
    const { env, sent } = fakeCfEnv(() => ({ messageId: 'm1' }))
    const headers = { 'List-Unsubscribe': '<https://x.test/profile#setting-email-digest>' }
    await sendEmail(env as never, { to: ['a@b.com'], subject: 'Hi', html: '<p>x</p>', headers })
    expect(sent[0].headers).toEqual(headers)
  })

  it('captures the thrown error.code in the failure result', async () => {
    const err = Object.assign(new Error('recipient suppressed'), { code: 'E_RECIPIENT_SUPPRESSED' })
    const { env } = fakeCfEnv(() => { throw err })
    const r = await sendEmail(env as never, { to: ['a@b.com'], subject: 'Hi', html: '<p>x</p>' })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('E_RECIPIENT_SUPPRESSED')
  })

  it('uses EMAIL_FROM / EMAIL_REPLY_TO when set', async () => {
    const captured: Record<string, unknown>[] = []
    const env = {
      EMAIL_PROVIDER: 'cloudflare' as const,
      EMAIL: { send: async (m: Record<string, unknown>) => { captured.push(m); return { messageId: 'm' } } },
      EMAIL_FROM: 'alerts@example.org',
      EMAIL_REPLY_TO: 'replies@example.org',
    }
    await sendEmail(env as never, { to: ['a@b.com'], subject: 'Hi', html: '<p>x</p>' })
    expect(captured[0].from).toBe('FloorVote <alerts@example.org>')
    expect(captured[0].replyTo).toBe('replies@example.org')
  })

  it('falls back to notifications@example.com when EMAIL_FROM is unset', async () => {
    const captured: Record<string, unknown>[] = []
    const env = {
      EMAIL_PROVIDER: 'cloudflare' as const,
      EMAIL: { send: async (m: Record<string, unknown>) => { captured.push(m); return { messageId: 'm' } } },
    }
    await sendEmail(env as never, { to: ['a@b.com'], subject: 'Hi', html: '<p>x</p>' })
    expect(captured[0].from).toBe('FloorVote <notifications@example.com>')
    expect(captured[0].replyTo).toBe('notifications@example.com')
  })

  it('replyTo defaults to EMAIL_FROM when EMAIL_REPLY_TO is unset', async () => {
    const captured: Record<string, unknown>[] = []
    const env = {
      EMAIL_PROVIDER: 'cloudflare' as const,
      EMAIL: { send: async (m: Record<string, unknown>) => { captured.push(m); return { messageId: 'm' } } },
      EMAIL_FROM: 'alerts@example.org',
    }
    await sendEmail(env as never, { to: ['a@b.com'], subject: 'Hi', html: '<p>x</p>' })
    expect(captured[0].replyTo).toBe('alerts@example.org')
  })
})

describe('unsubscribeHeaders', () => {
  it('builds an RFC-2369 List-Unsubscribe header pointing at the /profile setting anchor', () => {
    expect(unsubscribeHeaders('https://ri.example.com', 'setting-email-digest')).toEqual({
      'List-Unsubscribe': '<https://ri.example.com/profile#setting-email-digest>',
    })
  })
})

describe('sendMagicLink', () => {
  it('puts the sign-in URL in the text part without referencing a (nonexistent) button', async () => {
    const { env, sent } = fakeCfEnv(() => ({ messageId: 'm' }))
    await sendMagicLink('a@b.com', 'https://x.test/auth?token=abc', { ...env, APP_URL: 'https://x.test' } as never, 'login')
    const text = String(sent[0].text)
    expect(text).toContain('https://x.test/auth?token=abc')
    expect(text.toLowerCase()).not.toContain('button')
    const html = String(sent[0].html)
    expect(html).toContain('Sign in to FloorVote')  // button label
    expect(html).toContain('href="https://x.test/auth?token=abc"')
  })

  it('invite text names the association and includes the invite URL', async () => {
    const { env, sent } = fakeCfEnv(() => ({ messageId: 'm' }))
    await sendMagicLink('a@b.com', 'https://x.test/invite?token=xyz',
      { ...env, APP_URL: 'https://x.test', ASSOCIATION_NAME: 'RI Clerks' } as never, 'invite')
    const text = String(sent[0].text)
    expect(text).toContain('https://x.test/invite?token=xyz')
    expect(text).toContain('RI Clerks')
    // Self-recovery line: missing the invite isn't a dead end — point at the
    // login page (APP_URL) so a spam-filtered invite is recoverable.
    expect(text).toContain('request a new sign-in link')
    expect(text).toContain('\n\nhttps://x.test\n\n')
    const html = String(sent[0].html)
    expect(html).toContain('request a new sign-in link')
    expect(html).toContain('href="https://x.test"')
    // Shell masthead shows the instance name; CTA shows the invite button label.
    expect(html).toContain('RI Clerks')
    expect(html).toContain('Accept your invitation')
  })
})

describe('sendFeedback', () => {
  it('sends to the parsed OPERATOR_CONTACT_EMAILS recipients', async () => {
    const { env, sent } = fakeCfEnv(() => ({ messageId: 'm' }))
    await sendFeedback(
      { email: 'user@example.com' }, 'hello there', undefined,
      { ...env, OPERATOR_CONTACT_EMAILS: 'a@x.org, b@y.org' } as never,
    )
    expect(sent).toHaveLength(1)
    expect(sent[0].to).toEqual(['a@x.org', 'b@y.org'])
    expect(sent[0].subject).toBe('Feedback from user@example.com')
    const html = String(sent[0].html)
    expect(html).toContain('New feedback')
    expect(html).toContain('hello there')
    expect(html).toContain('user@example.com')
  })
})

describe('sendEmail — Resend', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('includes the derived text and custom headers in the Resend payload', async () => {
    let body: Record<string, unknown> = {}
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      body = JSON.parse(init.body as string)
      return new Response(null, { status: 200 })
    }))
    const env = { RESEND_API_KEY: 'k', EMAIL_PROVIDER: 'resend' as const }
    const headers = { 'List-Unsubscribe': '<https://x.test/profile>' }
    const r = await sendEmail(env as never, { to: ['a@b.com'], subject: 'Hi', html: '<p>Hello</p>', headers })
    expect(r.ok).toBe(true)
    expect(body.text).toBe('Hello')
    expect(body.headers).toEqual(headers)
  })
})
