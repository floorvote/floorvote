import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { sendAdminMagicLink } from '../../src/lib/adminEmail'
import { fakeBinding, stubResend, bothBindingFirst, bothResendFirst, RESEND_KEY } from '../helpers/mail'

const TO = 'admin@example.com'
const URL_ = 'https://admin.example.com/auth/callback?token=abc'

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

describe('sendAdminMagicLink: one provider', () => {
  it('POSTs to Resend with bearer auth and includes the link in the body', async () => {
    const resend = stubResend('ok')
    await sendAdminMagicLink(TO, URL_, { RESEND_API_KEY: RESEND_KEY })
    expect(resend.calls).toHaveLength(1)
    expect(resend.calls[0].url).toBe('https://api.resend.com/emails')
    expect(resend.calls[0].auth).toBe(`Bearer ${RESEND_KEY}`)
    expect(resend.calls[0].body.to).toEqual([TO])
    expect(resend.calls[0].body.html).toContain(URL_)
    expect(resend.calls[0].body.subject).toContain('admin')
  })

  it('sends through the binding alone when no Resend key is set', async () => {
    const cf = fakeBinding('ok')
    const resend = stubResend('ok')
    await sendAdminMagicLink(TO, URL_, { EMAIL_PROVIDER: 'cloudflare', EMAIL: cf.binding })
    expect(cf.sent).toHaveLength(1)
    expect(cf.sent[0].to).toEqual([TO])
    expect(resend.calls).toHaveLength(0)
  })

  it('puts the sign-in URL in the text part without referencing a (nonexistent) button', async () => {
    const cf = fakeBinding('ok')
    await sendAdminMagicLink('admin@b.com', 'https://admin.test/auth?token=abc', { EMAIL_PROVIDER: 'cloudflare', EMAIL: cf.binding })
    const text = String(cf.sent[0].text)
    expect(text).toContain('https://admin.test/auth?token=abc')
    expect(text.toLowerCase()).not.toContain('button')
  })

  it('throws when the only provider answers non-2xx, naming the provider and status', async () => {
    stubResend('down')
    await expect(sendAdminMagicLink(TO, 'https://x', { RESEND_API_KEY: RESEND_KEY })).rejects.toThrow('Email send failed (resend): 503')
  })

  it('throws when the only provider is a binding that throws', async () => {
    const cf = fakeBinding('down')
    await expect(sendAdminMagicLink(TO, 'https://x', { EMAIL_PROVIDER: 'cloudflare', EMAIL: cf.binding })).rejects.toThrow(/Email send failed \(cloudflare\).*binding is down/)
  })

  it('throws, rather than letting a fetch throw escape raw, when the only provider is unreachable', async () => {
    stubResend('throw')
    await expect(sendAdminMagicLink(TO, 'https://x', { RESEND_API_KEY: RESEND_KEY })).rejects.toThrow(/Email send failed \(resend\).*network unreachable/)
  })

  it('throws, and calls nothing, when no provider is configured', async () => {
    const resend = stubResend('ok')
    await expect(sendAdminMagicLink(TO, 'https://x', {})).rejects.toThrow(/Email send failed/)
    expect(resend.calls).toHaveLength(0)
  })

  it('throws without calling a provider when the address is malformed', async () => {
    const cf = fakeBinding('ok')
    await expect(sendAdminMagicLink('not-an-email', 'https://x', bothBindingFirst(cf.binding))).rejects.toThrow(/Invalid recipient/)
    expect(cf.sent).toHaveLength(0)
  })
})

describe('sendAdminMagicLink: fallback (sign-in purpose)', () => {
  it('goes out through Resend when the binding, tried first, is down', async () => {
    const cf = fakeBinding('down')
    const resend = stubResend('ok')
    await expect(sendAdminMagicLink(TO, URL_, bothBindingFirst(cf.binding))).resolves.toBeUndefined()
    expect(cf.sent).toHaveLength(1)
    expect(resend.calls).toHaveLength(1)
    expect(resend.calls[0].body.html).toContain(URL_)
    expect(resend.calls[0].body.to).toEqual([TO])
  })

  it('goes out through the binding when Resend, tried first, is down', async () => {
    const cf = fakeBinding('ok')
    const resend = stubResend('down')
    await expect(sendAdminMagicLink(TO, URL_, bothResendFirst(cf.binding))).resolves.toBeUndefined()
    expect(resend.calls).toHaveLength(1)
    expect(cf.sent).toHaveLength(1)
    expect(String(cf.sent[0].html)).toContain(URL_)
  })

  it('falls back when the first provider is unreachable (fetch throws)', async () => {
    const cf = fakeBinding('ok')
    const resend = stubResend('throw')
    await expect(sendAdminMagicLink(TO, URL_, bothResendFirst(cf.binding))).resolves.toBeUndefined()
    expect(resend.calls).toHaveLength(1)
    expect(cf.sent).toHaveLength(1)
  })

  it('falls back when the binding throws synchronously', async () => {
    const cf = fakeBinding('throw-sync')
    const resend = stubResend('ok')
    await expect(sendAdminMagicLink(TO, URL_, bothBindingFirst(cf.binding))).resolves.toBeUndefined()
    expect(cf.sent).toHaveLength(1)
    expect(resend.calls).toHaveLength(1)
  })

  it('does not touch the second provider when the first succeeds', async () => {
    const cf = fakeBinding('ok')
    const resend = stubResend('ok')
    await sendAdminMagicLink(TO, URL_, bothBindingFirst(cf.binding))
    expect(cf.sent).toHaveLength(1)
    expect(resend.calls).toHaveLength(0)
  })

  it('throws when both providers are down, after trying both, and says why each failed', async () => {
    const cf = fakeBinding('down')
    const resend = stubResend('down')
    const err = await sendAdminMagicLink(TO, URL_, bothBindingFirst(cf.binding)).catch((e: Error) => e)
    expect(err).toBeInstanceOf(Error)
    expect(cf.sent).toHaveLength(1)
    expect(resend.calls).toHaveLength(1)
    expect((err as Error).message).toMatch(/Email send failed/)
  })

  it('does not fall back for an address the first provider reports as permanently undeliverable', async () => {
    const cf = fakeBinding('suppressed')
    const resend = stubResend('ok')
    await expect(sendAdminMagicLink(TO, URL_, bothBindingFirst(cf.binding))).rejects.toThrow(/Email send failed \(cloudflare\)/)
    expect(resend.calls).toHaveLength(0)
  })

  it('keeps the default From and Reply-To, whichever provider carries it', async () => {
    const cf = fakeBinding('down')
    const resend = stubResend('ok')
    await sendAdminMagicLink(TO, URL_, { ...bothBindingFirst(cf.binding), EMAIL_FROM: 'alerts@example.org', EMAIL_REPLY_TO: 'replies@example.org' })
    expect(cf.sent[0].from).toBe('FloorVote <alerts@example.org>')
    expect(resend.calls[0].body.from).toBe('FloorVote <alerts@example.org>')
    expect(resend.calls[0].body.reply_to).toBe('replies@example.org')
  })

  it('still sends in demo mode: a sign-in login link is never suppressed', async () => {
    const cf = fakeBinding('ok')
    await sendAdminMagicLink(TO, URL_, { ...bothBindingFirst(cf.binding), DEMO_MODE: 'true' } as never)
    expect(cf.sent).toHaveLength(1)
  })
})
