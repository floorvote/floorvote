import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { SELF, env } from 'cloudflare:test'
import { app } from '../../src/index'
import { clearDb, seedUser, seedSession } from '../helpers'
import { getDb } from '../../src/db/client'
import { emailSendStats, associationConfig } from '../../src/db/schema'
import { fakeBinding, stubResend, bothBindingFirst } from '../../../shared/emailTestKit'

beforeEach(async () => {
  await clearDb()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('POST /feedback', () => {
  it('returns 401 without a session', async () => {
    const res = await SELF.fetch('http://localhost/api/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Hello' }),
    })
    expect(res.status).toBe(401)
  })

  it('returns 400 for empty message', async () => {
    const userId = await seedUser()
    const token = await seedSession(userId)

    const res = await SELF.fetch('http://localhost/api/feedback', {
      method: 'POST',
      headers: { Cookie: `session=${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '   ' }),
    })
    expect(res.status).toBe(400)
  })

  it('returns 400 for missing message', async () => {
    const userId = await seedUser()
    const token = await seedSession(userId)

    const res = await SELF.fetch('http://localhost/api/feedback', {
      method: 'POST',
      headers: { Cookie: `session=${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
  })

  it('returns 200 when Resend succeeds', async () => {
    const userId = await seedUser({ email: 'tester@example.com' })
    const token = await seedSession(userId)

    vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async () =>
      new Response('{"id":"mock-id"}', { status: 200 }),
    )

    const res = await SELF.fetch('http://localhost/api/feedback', {
      method: 'POST',
      headers: { Cookie: `session=${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Great tool!', pageUrl: 'http://localhost:5173/bills' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { ok: boolean }
    expect(body.ok).toBe(true)
  })

  it('is not counted toward email health: no email_send_stats row and no Resend usage reading (#709)', async () => {
    const userId = await seedUser({ email: 'tester@example.com' })
    const token = await seedSession(userId)

    vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async () =>
      new Response('{"id":"mock-id"}', { status: 200, headers: { 'x-resend-monthly-quota': '812', 'x-resend-daily-quota': '40' } }),
    )

    const res = await SELF.fetch('http://localhost/api/feedback', {
      method: 'POST',
      headers: { Cookie: `session=${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Great tool!' }),
    })
    expect(res.status).toBe(200)
    const db = getDb(env.DB)
    expect(await db.select().from(emailSendStats).all()).toEqual([])
    expect((await db.select().from(associationConfig).all()).filter(r => r.key.startsWith('resend_'))).toEqual([])
  })

  it('does not count a failed feedback send either (#709)', async () => {
    const userId = await seedUser()
    const token = await seedSession(userId)

    vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async () =>
      new Response('{"message":"invalid api key"}', { status: 401 }),
    )

    const res = await SELF.fetch('http://localhost/api/feedback', {
      method: 'POST',
      headers: { Cookie: `session=${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'This will fail' }),
    })
    expect(res.status).toBe(500)
    expect(await getDb(env.DB).select().from(emailSendStats).all()).toEqual([])
  })

  it('returns 500 when Resend fails', async () => {
    const userId = await seedUser()
    const token = await seedSession(userId)

    vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async () =>
      new Response('{"message":"invalid api key"}', { status: 401 }),
    )

    const res = await SELF.fetch('http://localhost/api/feedback', {
      method: 'POST',
      headers: { Cookie: `session=${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'This will fail' }),
    })
    expect(res.status).toBe(500)
  })

  it('returns 400 when message exceeds 20 KB (SEC-I4)', async () => {
    const userId = await seedUser()
    const token = await seedSession(userId)

    const res = await SELF.fetch('http://localhost/api/feedback', {
      method: 'POST',
      headers: { Cookie: `session=${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'a'.repeat(20_481) }),
    })
    expect(res.status).toBe(400)
  })

  it('returns 200 when message is exactly 20 KB (SEC-I4)', async () => {
    const userId = await seedUser({ email: 'tester@example.com' })
    const token = await seedSession(userId)

    vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async () =>
      new Response('{"id":"mock-id"}', { status: 200 }),
    )

    const res = await SELF.fetch('http://localhost/api/feedback', {
      method: 'POST',
      headers: { Cookie: `session=${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'a'.repeat(20_480) }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { ok: boolean }
    expect(body.ok).toBe(true)
  })
})

// Feedback is operator mail: the route names the purpose and the sender does
// the rest (fallback, never counted). These run the route in process with a
// fake binding and a faked Resend, so each can set what the providers do.
describe('POST /feedback: operator mail through the sender', () => {
  async function post(over: Record<string, unknown>, body: unknown = { message: 'Great tool!', pageUrl: 'http://localhost:5173/bills' }) {
    const userId = await seedUser({ email: 'tester@example.com' })
    const token = await seedSession(userId)
    const res = await app.request('/api/feedback', {
      method: 'POST',
      headers: { Cookie: `session=${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, { ...env, OPERATOR_CONTACT_EMAILS: 'a@x.org, b@y.org', APP_URL: 'http://localhost:5173', ...over })
    return res
  }

  let errorSpy: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  it('sends one email to the parsed OPERATOR_CONTACT_EMAILS recipients, saying who wrote it, from what page, and what', async () => {
    const cf = fakeBinding('ok')
    const res = await post({ EMAIL_PROVIDER: 'cloudflare', EMAIL: cf.binding })
    expect(res.status).toBe(200)
    expect(cf.sent).toHaveLength(1)
    expect(cf.sent[0].to).toEqual(['a@x.org', 'b@y.org'])
    expect(cf.sent[0].subject).toBe('Feedback from tester@example.com')
    const html = String(cf.sent[0].html)
    expect(html).toContain('New feedback')
    expect(html).toContain('Great tool!')
    expect(html).toContain('tester@example.com')
    expect(html).toContain('http://localhost:5173/bills')
  })

  it('escapes what the member wrote', async () => {
    const cf = fakeBinding('ok')
    await post({ EMAIL_PROVIDER: 'cloudflare', EMAIL: cf.binding }, { message: '<script>alert(1)</script>' })
    const html = String(cf.sent[0].html)
    expect(html).toContain('&lt;script&gt;')
    expect(html).not.toContain('<script>')
  })

  it('fails with 500, and calls no provider, when OPERATOR_CONTACT_EMAILS is empty', async () => {
    const cf = fakeBinding('ok')
    const res = await post({ EMAIL_PROVIDER: 'cloudflare', EMAIL: cf.binding, OPERATOR_CONTACT_EMAILS: '' })
    expect(res.status).toBe(500)
    expect(cf.sent).toHaveLength(0)
    expect(errorSpy.mock.calls.map(c => c.join(' ')).join('\n')).toMatch(/not configured|empty/i)
  })

  it('falls back to the second provider when the first is down', async () => {
    const cf = fakeBinding('down')
    const resend = stubResend()
    const res = await post({ ...bothBindingFirst(cf.binding) })
    expect(res.status).toBe(200)
    expect(cf.sent).toHaveLength(1)
    expect(resend.calls).toHaveLength(1)
    expect(resend.calls[0].body.to).toEqual(['a@x.org', 'b@y.org'])
    expect(resend.calls[0].body.subject).toBe('Feedback from tester@example.com')
  })

  it('writes nothing to email health when it goes out by fallback', async () => {
    stubResend()
    await post({ ...bothBindingFirst(fakeBinding('down').binding) })
    const db = getDb(env.DB)
    expect(await db.select().from(emailSendStats).all()).toEqual([])
    expect((await db.select().from(associationConfig).all()).filter(r => r.key.startsWith('resend_'))).toEqual([])
  })

  it('fails with 500 when every provider is down', async () => {
    stubResend('down', { status: 401, body: 'unauthorized' })
    const cf = fakeBinding('down')
    const res = await post({ ...bothBindingFirst(cf.binding) })
    expect(res.status).toBe(500)
    expect(cf.sent).toHaveLength(1)
  })

  it('fails with 500 for a suppressed recipient, without trying the other provider', async () => {
    const resend = stubResend()
    const cf = fakeBinding('suppressed')
    const res = await post({ ...bothBindingFirst(cf.binding) })
    expect(res.status).toBe(500)
    expect(resend.calls).toHaveLength(0)
  })
})

// One malformed OPERATOR_CONTACT_EMAILS entry must not block feedback to the
// good addresses (#781). The real sender rejects a whole message over one bad
// address, so before this the member's feedback failed with a 500.
describe('POST /feedback: a malformed OPERATOR_CONTACT_EMAILS entry', () => {
  async function post(contacts: string | undefined, extra: Record<string, unknown> = {}) {
    const userId = await seedUser({ email: 'tester@example.com' })
    const token = await seedSession(userId)
    return app.request('/api/feedback', {
      method: 'POST',
      headers: { Cookie: `session=${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Great tool!' }),
    }, { ...env, OPERATOR_CONTACT_EMAILS: contacts, APP_URL: 'http://localhost:5173', ...extra })
  }

  let errorSpy: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  const logged = () => errorSpy.mock.calls.map(c => c.map(String).join(' ')).join('\n')
  const viaCloudflare = (cf: ReturnType<typeof fakeBinding>) => ({ EMAIL_PROVIDER: 'cloudflare', EMAIL: cf.binding })

  it('sends to the valid address, answers 200, and logs the invalid entry', async () => {
    const cf = fakeBinding('ok')
    const res = await post('a@x.org, not-an-address', viaCloudflare(cf))
    expect(res.status).toBe(200)
    expect(cf.sent).toHaveLength(1)
    expect(cf.sent[0].to).toEqual(['a@x.org'])
    expect(logged()).toContain('not-an-address')
    expect(logged()).toContain('OPERATOR_CONTACT_EMAILS')
  })

  it('sends to the valid addresses around an invalid one, in order', async () => {
    const cf = fakeBinding('ok')
    await post('a@x.org, oops, b@y.org', viaCloudflare(cf))
    expect(cf.sent[0].to).toEqual(['a@x.org', 'b@y.org'])
  })

  it('answers 500, calls no provider, and logs the entries and the failure, when every entry is invalid', async () => {
    const cf = fakeBinding('ok')
    const resend = stubResend()
    const res = await post('oops, also@oops', { ...bothBindingFirst(cf.binding) })
    expect(res.status).toBe(500)
    expect(cf.sent).toHaveLength(0)
    expect(resend.calls).toHaveLength(0)
    expect(logged()).toContain('also@oops')
    expect(logged()).toContain('feedback send failed')
  })

  it('sends to every address, with nothing logged about addresses, when all are valid', async () => {
    const cf = fakeBinding('ok')
    const res = await post('a@x.org, b@y.org', viaCloudflare(cf))
    expect(res.status).toBe(200)
    expect(cf.sent[0].to).toEqual(['a@x.org', 'b@y.org'])
    expect(logged()).not.toContain('OPERATOR_CONTACT_EMAILS')
  })

  it('ignores blank entries and trims the rest', async () => {
    const cf = fakeBinding('ok')
    await post(' a@x.org ,, , b@y.org ,', viaCloudflare(cf))
    expect(cf.sent[0].to).toEqual(['a@x.org', 'b@y.org'])
  })

  it('sends to a duplicated address once, ignoring case', async () => {
    const cf = fakeBinding('ok')
    await post('A@x.org, a@x.org, b@y.org', viaCloudflare(cf))
    expect(cf.sent[0].to).toEqual(['A@x.org', 'b@y.org'])
  })

  it('drops the display-name form, and sends to the bare address beside it', async () => {
    const cf = fakeBinding('ok')
    const res = await post('Support <support@x.org>, b@y.org', viaCloudflare(cf))
    expect(res.status).toBe(200)
    expect(cf.sent[0].to).toEqual(['b@y.org'])
    expect(logged()).toContain('Support <support@x.org>')
  })

  it('keeps an upper-case address as written', async () => {
    const cf = fakeBinding('ok')
    await post('SUPPORT@X.ORG, oops', viaCloudflare(cf))
    expect(cf.sent[0].to).toEqual(['SUPPORT@X.ORG'])
  })

  it('falls back to the second provider for the valid address when the first is down', async () => {
    const cf = fakeBinding('down')
    const resend = stubResend()
    const res = await post('oops, a@x.org', { ...bothBindingFirst(cf.binding) })
    expect(res.status).toBe(200)
    expect(resend.calls[0].body.to).toEqual(['a@x.org'])
  })
})

