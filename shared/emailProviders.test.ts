import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  resendProvider, cloudflareProvider, providersFromEnv, primaryProviderName, fallbackProviderName, hasConfiguredProvider, configuredProviders,
  type OutgoingEmail, type CloudflareEmailBinding,
} from './emailProviders'

// The adapters are the only code that knows the transports: Resend's HTTP API
// and the Cloudflare send_email binding. Everything above them sees an Attempt.

const email: OutgoingEmail = {
  to: ['jane@example.com'],
  from: 'FloorVote <notifications@example.org>',
  replyTo: 'replies@example.org',
  subject: 'Hello',
  html: '<p>Hello</p>',
  text: 'Hello',
}

function fetchReturning(res: Response) {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => res)
}

describe('resendProvider', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('posts the message to the Resend API with the key and every field', async () => {
    const fetchImpl = fetchReturning(new Response(JSON.stringify({ id: 'rs-1' }), { status: 200 }))
    await resendProvider('test-api-key', fetchImpl as never).send({ ...email, headers: { 'List-Unsubscribe': '<https://x.test/p>' } })
    expect(fetchImpl).toHaveBeenCalledOnce()
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('https://api.resend.com/emails')
    expect(init?.method).toBe('POST')
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer test-api-key')
    expect(JSON.parse(String(init?.body))).toEqual({
      from: email.from, to: email.to, subject: 'Hello', html: '<p>Hello</p>', text: 'Hello',
      reply_to: 'replies@example.org', headers: { 'List-Unsubscribe': '<https://x.test/p>' },
    })
  })

  it('leaves headers out of the payload when the message has none', async () => {
    const fetchImpl = fetchReturning(new Response('{}', { status: 200 }))
    await resendProvider('test-api-key', fetchImpl as never).send(email)
    expect(fetchImpl).toHaveBeenCalledOnce()
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body))).not.toHaveProperty('headers')
  })

  it('returns the message id on success', async () => {
    const fetchImpl = fetchReturning(new Response(JSON.stringify({ id: 'rs-1' }), { status: 200 }))
    const a = await resendProvider('test-api-key', fetchImpl as never).send(email)
    expect(a).toMatchObject({ ok: true, provider: 'resend', messageId: 'rs-1' })
  })

  it('treats an HTTP error as a temporary failure carrying the status', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const fetchImpl = fetchReturning(new Response('server error', { status: 500 }))
    const a = await resendProvider('test-api-key', fetchImpl as never).send(email)
    expect(a).toMatchObject({ ok: false, provider: 'resend', error: '500', permanent: false })
    vi.restoreAllMocks()
  })

  it('treats a rejected key (401) as temporary, so the other provider can still deliver', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const a = await resendProvider('test-api-key', fetchReturning(new Response('bad key', { status: 401 })) as never).send(email)
    expect(a).toMatchObject({ ok: false, permanent: false, error: '401' })
    vi.restoreAllMocks()
  })

  it('turns a fetch that throws into a temporary failure instead of throwing', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const fetchImpl = vi.fn(async () => { throw new TypeError('network connection lost') })
    const a = await resendProvider('test-api-key', fetchImpl as never).send(email)
    expect(a).toMatchObject({ ok: false, provider: 'resend', permanent: false })
    expect(a.ok ? '' : a.error).toBe('fetch failed: network connection lost')
    vi.restoreAllMocks()
  })

  it('reads the quota headers into the attempt', async () => {
    const res = new Response('{}', { status: 200, headers: { 'x-resend-monthly-quota': '900', 'x-resend-daily-quota': '12' } })
    const a = await resendProvider('test-api-key', fetchReturning(res) as never).send(email)
    expect(a.usage).toEqual({ monthlyUsed: 900, dailyUsed: 12, throttled: false })
  })

  it('marks a 429 as throttled', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const a = await resendProvider('test-api-key', fetchReturning(new Response('slow down', { status: 429 })) as never).send(email)
    expect(a).toMatchObject({ ok: false, permanent: false, error: '429' })
    expect(a.usage).toEqual({ monthlyUsed: null, dailyUsed: null, throttled: true })
    vi.restoreAllMocks()
  })

  it('reports no usage when the response carries no quota headers and is not a 429', async () => {
    const a = await resendProvider('test-api-key', fetchReturning(new Response('{}', { status: 200 })) as never).send(email)
    expect(a.ok).toBe(true)
    expect(a.usage).toBeUndefined()
  })

  it('uses the global fetch at send time when none is injected', async () => {
    const stub = fetchReturning(new Response(JSON.stringify({ id: 'rs-g' }), { status: 200 }))
    const provider = resendProvider('test-api-key')
    vi.stubGlobal('fetch', stub)
    const a = await provider.send(email)
    expect(stub).toHaveBeenCalledOnce()
    expect(a).toMatchObject({ ok: true, messageId: 'rs-g' })
  })
})

function binding(impl: (m: Record<string, unknown>) => unknown): CloudflareEmailBinding & { sent: Record<string, unknown>[] } {
  const sent: Record<string, unknown>[] = []
  return { sent, send: async (m) => { sent.push(m as Record<string, unknown>); return impl(m as Record<string, unknown>) } }
}

const thrown = (code: string | undefined, message = 'x') =>
  () => { throw Object.assign(new Error(message), code ? { code } : {}) }

describe('cloudflareProvider', () => {
  afterEach(() => vi.restoreAllMocks())

  it('hands every field to the binding', async () => {
    const b = binding(() => ({ messageId: 'cf-1' }))
    await cloudflareProvider(b).send({ ...email, headers: { 'X-Test': '1' } })
    expect(b.sent[0]).toEqual({
      to: email.to, from: email.from, subject: 'Hello', html: '<p>Hello</p>', text: 'Hello',
      replyTo: 'replies@example.org', headers: { 'X-Test': '1' },
    })
  })

  it('returns the message id on success', async () => {
    const a = await cloudflareProvider(binding(() => ({ messageId: 'cf-1' }))).send(email)
    expect(a).toMatchObject({ ok: true, provider: 'cloudflare', messageId: 'cf-1' })
  })

  it('classifies a suppressed recipient as permanent, keeping the code in the error', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const a = await cloudflareProvider(binding(thrown('E_RECIPIENT_SUPPRESSED', 'suppressed'))).send(email)
    expect(a).toMatchObject({ ok: false, provider: 'cloudflare', permanent: true, error: 'E_RECIPIENT_SUPPRESSED: suppressed' })
  })

  it('classifies a rate limit as temporary', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const a = await cloudflareProvider(binding(thrown('E_RATE_LIMIT_EXCEEDED', 'slow down'))).send(email)
    expect(a).toMatchObject({ ok: false, permanent: false, error: 'E_RATE_LIMIT_EXCEEDED: slow down' })
  })

  it('classifies a binding allowlist refusal as temporary: the other provider can still deliver', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const a = await cloudflareProvider(binding(thrown('E_RECIPIENT_NOT_ALLOWED', 'not allowed'))).send(email)
    expect(a).toMatchObject({ ok: false, permanent: false, error: 'E_RECIPIENT_NOT_ALLOWED: not allowed' })
  })

  it('classifies an error without a code as temporary, with its message', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const a = await cloudflareProvider(binding(thrown(undefined, 'internal'))).send(email)
    expect(a).toMatchObject({ ok: false, permanent: false, error: 'internal' })
  })

  it('handles a non-Error throw', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const a = await cloudflareProvider(binding(() => { throw 'boom' })).send(email)
    expect(a).toMatchObject({ ok: false, permanent: false, error: 'boom' })
  })

  it('fails temporarily, without throwing, when the binding is missing', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const a = await cloudflareProvider(undefined).send(email)
    expect(a).toMatchObject({ ok: false, provider: 'cloudflare', permanent: false })
    expect(a.ok ? '' : a.error).toMatch(/binding/i)
  })
})

describe('provider selection from env', () => {
  const EMAIL = binding(() => ({}))

  it('puts Cloudflare first when chosen and bound, with Resend second when it has a key', () => {
    expect(providersFromEnv({ EMAIL_PROVIDER: 'cloudflare', EMAIL, RESEND_API_KEY: 'test-api-key' }).map(p => p.name)).toEqual(['cloudflare', 'resend'])
  })

  it('puts Resend first by default, with Cloudflare second when bound', () => {
    expect(providersFromEnv({ RESEND_API_KEY: 'test-api-key', EMAIL }).map(p => p.name)).toEqual(['resend', 'cloudflare'])
  })

  it('has one provider when only Cloudflare is configured', () => {
    expect(providersFromEnv({ EMAIL_PROVIDER: 'cloudflare', EMAIL }).map(p => p.name)).toEqual(['cloudflare'])
  })

  it('has one provider when only Resend is configured', () => {
    expect(providersFromEnv({ RESEND_API_KEY: 'test-api-key' }).map(p => p.name)).toEqual(['resend'])
  })

  it('falls back to Resend first when Cloudflare is chosen but not bound', () => {
    expect(providersFromEnv({ EMAIL_PROVIDER: 'cloudflare', RESEND_API_KEY: 'test-api-key' }).map(p => p.name)).toEqual(['resend'])
    expect(primaryProviderName({ EMAIL_PROVIDER: 'cloudflare' })).toBe('resend')
  })

  it('still tries Resend when nothing is configured, as the API always has', () => {
    expect(providersFromEnv({}).map(p => p.name)).toEqual(['resend'])
  })

  it('names the other provider only when it is configured', () => {
    expect(fallbackProviderName({ RESEND_API_KEY: 'test-api-key' }, 'cloudflare')).toBe('resend')
    expect(fallbackProviderName({}, 'cloudflare')).toBeNull()
    expect(fallbackProviderName({ EMAIL }, 'resend')).toBe('cloudflare')
    expect(fallbackProviderName({}, 'resend')).toBeNull()
  })
})

describe('hasConfiguredProvider', () => {
  const EMAIL = binding(() => ({}))

  it('is false when nothing is configured, though providersFromEnv still lists Resend', () => {
    expect(hasConfiguredProvider({})).toBe(false)
    expect(hasConfiguredProvider({ EMAIL_PROVIDER: 'cloudflare' })).toBe(false)
    expect(hasConfiguredProvider({ EMAIL_PROVIDER: 'resend' })).toBe(false)
  })

  it('is false for a blank Resend key', () => {
    expect(hasConfiguredProvider({ RESEND_API_KEY: '' })).toBe(false)
  })

  it('is true with only a Resend key', () => {
    expect(hasConfiguredProvider({ RESEND_API_KEY: 'test-api-key' })).toBe(true)
  })

  it('is true with only the binding, whichever provider is chosen', () => {
    expect(hasConfiguredProvider({ EMAIL })).toBe(true)
    expect(hasConfiguredProvider({ EMAIL_PROVIDER: 'cloudflare', EMAIL })).toBe(true)
    expect(hasConfiguredProvider({ EMAIL_PROVIDER: 'resend', EMAIL })).toBe(true)
  })

  it('is true with both', () => {
    expect(hasConfiguredProvider({ RESEND_API_KEY: 'test-api-key', EMAIL })).toBe(true)
  })
})

describe('configuredProviders', () => {
  const EMAIL = binding(() => ({}))

  it('is empty when nothing is configured', () => {
    expect(configuredProviders({})).toEqual([])
    expect(configuredProviders({ EMAIL_PROVIDER: 'cloudflare' })).toEqual([])
    expect(configuredProviders({ RESEND_API_KEY: '' })).toEqual([])
  })

  it('keeps both, primary first, when both are configured', () => {
    expect(configuredProviders({ EMAIL_PROVIDER: 'cloudflare', EMAIL, RESEND_API_KEY: 'test-api-key' }).map(p => p.name)).toEqual(['cloudflare', 'resend'])
    expect(configuredProviders({ EMAIL, RESEND_API_KEY: 'test-api-key' }).map(p => p.name)).toEqual(['resend', 'cloudflare'])
  })

  it('drops a keyless Resend even when it is the primary, leaving the binding', () => {
    expect(configuredProviders({ EMAIL_PROVIDER: 'resend', EMAIL }).map(p => p.name)).toEqual(['cloudflare'])
    expect(configuredProviders({ EMAIL }).map(p => p.name)).toEqual(['cloudflare'])
  })

  it('has Resend alone when only the key is set', () => {
    expect(configuredProviders({ RESEND_API_KEY: 'test-api-key' }).map(p => p.name)).toEqual(['resend'])
    expect(configuredProviders({ EMAIL_PROVIDER: 'cloudflare', RESEND_API_KEY: 'test-api-key' }).map(p => p.name)).toEqual(['resend'])
  })
})
