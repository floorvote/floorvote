import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createSender, resolveFrom, resolveFromBulk, resolveReplyTo, type SignInMessage, type SignInEvent, type HealthRecorder, type SenderEnv } from './emailSender'
import type { Attempt, EmailProvider, OutgoingEmail, ProviderName } from './emailProviders'

// The sender against in-memory providers: no fetch, no binding. The adapters'
// own tests (emailProviders.test.ts) cover the transports.

type Outcome = 'ok' | 'temporary' | 'permanent' | 'throw'

function memoryProvider(name: ProviderName, outcomes: Outcome[] | Outcome = 'ok') {
  const sent: OutgoingEmail[] = []
  let i = 0
  const provider: EmailProvider & { sent: OutgoingEmail[] } = {
    name,
    sent,
    async send(email) {
      sent.push(email)
      const outcome = Array.isArray(outcomes) ? outcomes[Math.min(i++, outcomes.length - 1)] : outcomes
      if (outcome === 'throw') throw new Error(`${name} adapter blew up`)
      if (outcome === 'ok') return { ok: true, provider: name, messageId: `${name}-${sent.length}` }
      return { ok: false, provider: name, error: outcome === 'permanent' ? 'E_RECIPIENT_SUPPRESSED: gone' : 'outage', permanent: outcome === 'permanent' }
    },
  }
  return provider
}

function memoryRecorder() {
  const calls: Attempt[][] = []
  const recorder: HealthRecorder & { calls: Attempt[][] } = { calls, async record(attempts) { calls.push(attempts) } }
  return recorder
}

function signIn(overrides: Partial<SignInMessage> = {}): SignInMessage & { events: SignInEvent[] } {
  const events: SignInEvent[] = []
  return {
    purpose: 'sign-in', link: 'login', to: ['jane@example.com'],
    subject: 'Your sign-in link', html: '<p>Sign in <a href="https://x.test/v">here</a></p>',
    recordEvent: async (e) => { events.push(e) },
    events,
    ...overrides,
  }
}

const env: SenderEnv = { EMAIL_FROM: 'notifications@example.org', DEMO_MODE: 'false' }

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

describe('sign-in: delivery and fallback', () => {
  it('sends through the first provider and leaves the second alone', async () => {
    const first = memoryProvider('cloudflare'), second = memoryProvider('resend')
    const r = await createSender(env, { providers: [first, second] }).send(signIn())
    expect(r).toMatchObject({ ok: true, provider: 'cloudflare', messageId: 'cloudflare-1' })
    expect(r.attempts).toHaveLength(1)
    expect(second.sent).toHaveLength(0)
  })

  it('goes out through the second provider when the first has an outage', async () => {
    const first = memoryProvider('cloudflare', 'temporary'), second = memoryProvider('resend')
    const r = await createSender(env, { providers: [first, second] }).send(signIn())
    expect(r).toMatchObject({ ok: true, provider: 'resend' })
    expect(r.attempts.map(a => `${a.provider}:${a.ok}`)).toEqual(['cloudflare:false', 'resend:true'])
    expect(second.sent[0].to).toEqual(['jane@example.com'])
  })

  it('counts each attempt of a rescued send to its own provider', async () => {
    const recorder = memoryRecorder()
    await createSender(env, { recorder, providers: [memoryProvider('cloudflare', 'temporary'), memoryProvider('resend')] }).send(signIn())
    expect(recorder.calls).toHaveLength(1)
    expect(recorder.calls[0].map(a => ({ provider: a.provider, ok: a.ok }))).toEqual([
      { provider: 'cloudflare', ok: false },
      { provider: 'resend', ok: true },
    ])
  })

  it('treats a suppressed recipient as permanent and does not retry it through the other provider', async () => {
    const first = memoryProvider('cloudflare', 'permanent'), second = memoryProvider('resend')
    const r = await createSender(env, { providers: [first, second] }).send(signIn())
    expect(r).toMatchObject({ ok: false, provider: 'cloudflare', permanent: true })
    expect(second.sent).toHaveLength(0)
  })

  it('reports an outage on both providers as temporary, with one attempt on each and no more', async () => {
    const first = memoryProvider('cloudflare', 'temporary'), second = memoryProvider('resend', 'temporary')
    const r = await createSender(env, { providers: [first, second] }).send(signIn())
    expect(r).toMatchObject({ ok: false, provider: 'resend', permanent: false, error: 'outage' })
    expect(first.sent).toHaveLength(1)
    expect(second.sent).toHaveLength(1)
  })

  it('makes one attempt and reports temporary when only one provider is configured', async () => {
    const only = memoryProvider('resend', 'temporary')
    const r = await createSender(env, { providers: [only] }).send(signIn())
    expect(r).toMatchObject({ ok: false, provider: 'resend', permanent: false })
    expect(only.sent).toHaveLength(1)
  })

  it('treats a provider that throws as a temporary failure, and falls back', async () => {
    const r = await createSender(env, { providers: [memoryProvider('cloudflare', 'throw'), memoryProvider('resend')] }).send(signIn())
    expect(r).toMatchObject({ ok: true, provider: 'resend' })
    expect(r.attempts[0]).toMatchObject({ ok: false, provider: 'cloudflare', permanent: false })
  })

  it('fails temporarily, without throwing, when no provider is available', async () => {
    const r = await createSender(env, { providers: [] }).send(signIn())
    expect(r).toMatchObject({ ok: false, provider: null, permanent: false })
    expect(r.ok ? '' : r.error).toMatch(/no email provider/i)
  })
})

describe('the address check, before any provider', () => {
  it('fails an invalid address as permanent without calling a provider', async () => {
    const first = memoryProvider('cloudflare'), second = memoryProvider('resend')
    const recorder = memoryRecorder()
    const r = await createSender(env, { recorder, providers: [first, second] }).send(signIn({ to: ['jane@example.gov;'] }))
    expect(r).toMatchObject({ ok: false, provider: null, permanent: true })
    expect(r.ok ? '' : r.error).toContain('jane@example.gov;')
    expect(first.sent).toHaveLength(0)
    expect(second.sent).toHaveLength(0)
    expect(recorder.calls.flat()).toHaveLength(0)
  })

  it('fails when any one of several recipients is invalid', async () => {
    const first = memoryProvider('cloudflare')
    const r = await createSender(env, { providers: [first] }).send(signIn({ to: ['jane@example.com', 'not-an-address'] }))
    expect(r).toMatchObject({ ok: false, permanent: true })
    expect(first.sent).toHaveLength(0)
  })

  it('fails a message with no recipients as permanent', async () => {
    const first = memoryProvider('cloudflare')
    const r = await createSender(env, { providers: [first] }).send(signIn({ to: [] }))
    expect(r).toMatchObject({ ok: false, permanent: true })
    expect(first.sent).toHaveLength(0)
  })
})

describe('sign-in events, one per attempt', () => {
  it('writes one email_sent event for a send that worked first time', async () => {
    const m = signIn()
    await createSender(env, { providers: [memoryProvider('cloudflare'), memoryProvider('resend')] }).send(m)
    expect(m.events).toEqual([{ event: 'email_sent', provider: 'cloudflare', reason: null, messageId: 'cloudflare-1' }])
  })

  it('writes both halves of a rescued send: the failure with its reason, then the success', async () => {
    const m = signIn()
    await createSender(env, { providers: [memoryProvider('cloudflare', 'temporary'), memoryProvider('resend')] }).send(m)
    expect(m.events).toEqual([
      { event: 'email_send_failed', provider: 'cloudflare', reason: 'outage', messageId: null },
      { event: 'email_sent', provider: 'resend', reason: null, messageId: 'resend-1' },
    ])
  })

  it('writes email_bounced for a permanent failure', async () => {
    const m = signIn()
    await createSender(env, { providers: [memoryProvider('cloudflare', 'permanent'), memoryProvider('resend')] }).send(m)
    expect(m.events).toEqual([{ event: 'email_bounced', provider: 'cloudflare', reason: 'E_RECIPIENT_SUPPRESSED: gone', messageId: null }])
  })

  it('writes one email_send_failed event with no provider for an invalid address', async () => {
    const m = signIn({ to: ['jane@example.gov;'] })
    await createSender(env, { providers: [memoryProvider('cloudflare')] }).send(m)
    expect(m.events).toEqual([{ event: 'email_send_failed', provider: null, reason: 'invalid recipient address; not sent', messageId: null }])
  })

  it('still reports the send as delivered when writing an event fails', async () => {
    const r = await createSender(env, { providers: [memoryProvider('cloudflare'), memoryProvider('resend')] })
      .send(signIn({ recordEvent: async () => { throw new Error('db down') } }))
    expect(r).toMatchObject({ ok: true, provider: 'cloudflare' })
  })
})

describe('sign-in in demo mode', () => {
  const demo: SenderEnv = { ...env, DEMO_MODE: 'true' }

  it('suppresses an invite: no provider called, no events, and the send is not a failure', async () => {
    const first = memoryProvider('cloudflare'), recorder = memoryRecorder()
    const m = signIn({ link: 'invite' })
    const r = await createSender(demo, { recorder, providers: [first] }).send(m)
    expect(r).toMatchObject({ ok: true, provider: null, skipped: 'demo-mode' })
    expect(first.sent).toHaveLength(0)
    expect(m.events).toEqual([])
    expect(recorder.calls.flat()).toHaveLength(0)
  })

  it('sends a login link', async () => {
    const first = memoryProvider('cloudflare')
    const r = await createSender(demo, { providers: [first] }).send(signIn({ link: 'login' }))
    expect(r).toMatchObject({ ok: true, provider: 'cloudflare' })
    expect(first.sent).toHaveLength(1)
  })

  it('sends invites when demo mode is off', async () => {
    const first = memoryProvider('cloudflare')
    await createSender(env, { providers: [first] }).send(signIn({ link: 'invite' }))
    expect(first.sent).toHaveLength(1)
  })
})

describe('health counting', () => {
  it('counts nothing when no recorder is supplied, and still sends', async () => {
    const first = memoryProvider('cloudflare', 'temporary'), second = memoryProvider('resend')
    const r = await createSender(env, { providers: [first, second] }).send(signIn())
    expect(r).toMatchObject({ ok: true, provider: 'resend' })
  })

  it('counts a permanent failure, so the recorder can tell it from an outage', async () => {
    const recorder = memoryRecorder()
    await createSender(env, { recorder, providers: [memoryProvider('cloudflare', 'permanent')] }).send(signIn())
    expect(recorder.calls[0]).toEqual([expect.objectContaining({ provider: 'cloudflare', ok: false, permanent: true })])
  })

  it('still reports the send as delivered when the recorder throws', async () => {
    const recorder: HealthRecorder = { record: async () => { throw new Error('stats write failed') } }
    const r = await createSender(env, { recorder, providers: [memoryProvider('cloudflare')] }).send(signIn())
    expect(r).toMatchObject({ ok: true, provider: 'cloudflare' })
  })
})

describe('message defaults', () => {
  it('sends from the default From, with the default Reply-To and a text part derived from the html', async () => {
    const first = memoryProvider('cloudflare')
    await createSender({ ...env, EMAIL_REPLY_TO: 'replies@example.org' }, { providers: [first] }).send(signIn())
    expect(first.sent[0]).toMatchObject({
      from: 'FloorVote <notifications@example.org>',
      replyTo: 'replies@example.org',
      subject: 'Your sign-in link',
      text: 'Sign in here (https://x.test/v)',
    })
  })

  it('keeps a hand-written text part and forwards headers', async () => {
    const first = memoryProvider('cloudflare')
    await createSender(env, { providers: [first] }).send(signIn({ text: 'hand-written', headers: { 'X-Test': '1' } }))
    expect(first.sent[0]).toMatchObject({ text: 'hand-written', headers: { 'X-Test': '1' } })
  })

  it('sends the same message to the fallback provider', async () => {
    const first = memoryProvider('cloudflare', 'temporary'), second = memoryProvider('resend')
    await createSender(env, { providers: [first, second] }).send(signIn())
    expect(second.sent).toHaveLength(1)
    expect(second.sent[0]).toEqual(first.sent[0])
  })

  it('resolves From and Reply-To from env, with an example.com fallback', () => {
    expect(resolveFrom({})).toBe('FloorVote <notifications@example.com>')
    expect(resolveFrom({ EMAIL_FROM: 'a@example.org' })).toBe('FloorVote <a@example.org>')
    expect(resolveFromBulk({ EMAIL_FROM: 'a@example.org' })).toBe('FloorVote <a@example.org>')
    expect(resolveFromBulk({ EMAIL_FROM: 'a@example.org', EMAIL_FROM_BULK: 'b@mail.example.org' })).toBe('FloorVote <b@mail.example.org>')
    expect(resolveReplyTo({})).toBe('notifications@example.com')
    expect(resolveReplyTo({ EMAIL_FROM: 'a@example.org' })).toBe('a@example.org')
    expect(resolveReplyTo({ EMAIL_FROM: 'a@example.org', EMAIL_REPLY_TO: 'r@example.org' })).toBe('r@example.org')
  })
})

describe('batches', () => {
  it('sends each message once and reports a mixed batch per message, in order', async () => {
    // The first provider fails differently per recipient; the second always works.
    const sentTo: string[] = []
    const first: EmailProvider = {
      name: 'cloudflare',
      async send(email) {
        sentTo.push(`cloudflare:${email.to[0]}`)
        if (email.to[0].startsWith('gone')) return { ok: false, provider: 'cloudflare', error: 'E_RECIPIENT_SUPPRESSED: gone', permanent: true }
        if (email.to[0].startsWith('flaky')) return { ok: false, provider: 'cloudflare', error: 'outage', permanent: false }
        return { ok: true, provider: 'cloudflare', messageId: 'cf' }
      },
    }
    const second: EmailProvider = {
      name: 'resend',
      async send(email) { sentTo.push(`resend:${email.to[0]}`); return { ok: true, provider: 'resend', messageId: 'rs' } },
    }
    const recorder = memoryRecorder()
    const r = await createSender(env, { recorder, providers: [first, second] }).sendBatch([
      signIn({ to: ['ok@example.com'] }),
      signIn({ to: ['gone@example.com'] }),
      signIn({ to: ['flaky@example.com'] }),
      signIn({ to: ['bad-address'] }),
    ])
    expect(r).toMatchObject({ sent: 2, failed: 2, skipped: 0 })
    expect(r.results.map(x => (x.ok ? `ok:${x.provider}` : `fail:${x.permanent ? 'permanent' : 'temporary'}`))).toEqual([
      'ok:cloudflare', 'fail:permanent', 'ok:resend', 'fail:permanent',
    ])
    expect(sentTo.sort()).toEqual(['cloudflare:flaky@example.com', 'cloudflare:gone@example.com', 'cloudflare:ok@example.com', 'resend:flaky@example.com'])
    // One recorder call for the whole batch, holding every attempt.
    expect(recorder.calls).toHaveLength(1)
    expect(recorder.calls[0].map(a => `${a.provider}:${a.ok}`).sort()).toEqual(['cloudflare:false', 'cloudflare:false', 'cloudflare:true', 'resend:true'])
  })

  it('returns an empty result for an empty batch without counting, and counts the next real one', async () => {
    const recorder = memoryRecorder()
    const sender = createSender(env, { recorder, providers: [memoryProvider('cloudflare')] })
    expect(await sender.sendBatch([])).toEqual({ sent: 0, failed: 0, skipped: 0, results: [] })
    expect(recorder.calls).toHaveLength(0)
    expect((await sender.sendBatch([signIn()])).sent).toBe(1)
    expect(recorder.calls).toHaveLength(1)
  })

  it('skips demo-suppressed messages and sends the rest', async () => {
    const first = memoryProvider('cloudflare')
    const r = await createSender({ ...env, DEMO_MODE: 'true' }, { providers: [first] }).sendBatch([
      signIn({ link: 'invite', to: ['a@example.com'] }),
      signIn({ link: 'login', to: ['b@example.com'] }),
    ])
    expect(r).toMatchObject({ sent: 1, failed: 0, skipped: 1 })
    expect(first.sent.map(e => e.to[0])).toEqual(['b@example.com'])
  })

  it('sends more messages than the concurrency bound, each exactly once', async () => {
    const first = memoryProvider('cloudflare')
    const messages = Array.from({ length: 21 }, (_, i) => signIn({ to: [`u${i}@example.com`] }))
    const r = await createSender(env, { providers: [first] }).sendBatch(messages)
    expect(r.sent).toBe(21)
    expect(new Set(first.sent.map(e => e.to[0])).size).toBe(21)
    expect(first.sent).toHaveLength(21)
  })
})

describe('default providers from env', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('falls back from the Cloudflare binding to Resend over fetch when both are configured', async () => {
    const fetchStub = vi.fn(async () => new Response(JSON.stringify({ id: 'rs-9' }), { status: 200 }))
    vi.stubGlobal('fetch', fetchStub)
    const EMAIL = { send: vi.fn(async () => { throw Object.assign(new Error('down'), { code: 'E_INTERNAL_SERVER_ERROR' }) }) }
    const r = await createSender({ ...env, EMAIL_PROVIDER: 'cloudflare', EMAIL, RESEND_API_KEY: 'test-api-key' }).send(signIn())
    expect(r).toMatchObject({ ok: true, provider: 'resend', messageId: 'rs-9' })
    expect(EMAIL.send).toHaveBeenCalledOnce()
    expect(fetchStub).toHaveBeenCalledOnce()
  })

  it('makes a single attempt when only the binding is configured', async () => {
    const fetchStub = vi.fn()
    vi.stubGlobal('fetch', fetchStub)
    const EMAIL = { send: vi.fn(async () => { throw Object.assign(new Error('down'), { code: 'E_INTERNAL_SERVER_ERROR' }) }) }
    const r = await createSender({ ...env, EMAIL_PROVIDER: 'cloudflare', EMAIL }).send(signIn())
    expect(r).toMatchObject({ ok: false, provider: 'cloudflare', permanent: false })
    expect(fetchStub).not.toHaveBeenCalled()
  })
})
