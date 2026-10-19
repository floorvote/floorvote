import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  createSender, resolveFrom, resolveFromBulk, resolveReplyTo,
  type SignInMessage, type SignInEvent, type AccountMessage, type NotificationMessage, type BulkMessage, type OperatorMessage, type OutageAlertMessage,
  type HealthRecorder, type SenderEnv,
} from './emailSender'
import { memoryProvider, memoryRecorder } from './emailTestKit'
import type { EmailProvider } from './emailProviders'

// The sender against in-memory providers: no fetch, no binding. The adapters'
// own tests (emailProviders.test.ts) cover the transports.

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

  it('falls back from Resend to the binding when the Resend fetch throws, keeping why in the first attempt', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('network down') }))
    const EMAIL = { send: vi.fn(async () => ({ messageId: 'cf-1' })) }
    const r = await createSender({ ...env, EMAIL_PROVIDER: 'resend', EMAIL, RESEND_API_KEY: 'test-api-key' }).send(signIn())
    expect(r).toMatchObject({ ok: true, provider: 'cloudflare', messageId: 'cf-1' })
    expect(r.attempts.map(a => `${a.provider}:${a.ok}`)).toEqual(['resend:false', 'cloudflare:true'])
    expect(r.attempts[0]).toMatchObject({ ok: false, permanent: false })
    expect((r.attempts[0] as { error: string }).error).toContain('fetch failed')
  })

  it('reports a Resend fetch that throws, with nothing else configured, as one temporary failure that says why', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('network down') }))
    const r = await createSender({ ...env, RESEND_API_KEY: 'test-api-key' }).send(signIn())
    expect(r).toMatchObject({ ok: false, provider: 'resend', permanent: false })
    expect((r as { error: string }).error).toContain('fetch failed')
    expect((r as { error: string }).error).toContain('network down')
    expect(r.attempts).toHaveLength(1)
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

// The account purpose (email-change emails and the "this wasn't me" report) and
// the notification purpose (mentions and replies) share one rule: they fall
// back, count toward email health, and a demo instance never sends them.
const account = (overrides: Partial<AccountMessage> = {}): AccountMessage => ({
  purpose: 'account', to: ['jane@example.com'], subject: 'Confirm your new email', html: '<p>Confirm <a href="https://x.test/c">here</a></p>',
  ...overrides,
})
const notification = (overrides: Partial<NotificationMessage> = {}): NotificationMessage => ({
  purpose: 'notification', to: ['jane@example.com'], subject: '[HB 1] New comment', html: '<p>Ann commented</p>',
  headers: { 'In-Reply-To': '<bill-1@x.test>', References: '<bill-1@x.test>' },
  ...overrides,
})

describe.each([
  ['account', account],
  ['notification', notification],
] as const)('%s purpose', (_purpose, make) => {
  it('goes out through the second provider when the first has an outage', async () => {
    const first = memoryProvider('cloudflare', 'temporary'), second = memoryProvider('resend')
    const r = await createSender(env, { providers: [first, second] }).send(make())
    expect(r).toMatchObject({ ok: true, provider: 'resend' })
    expect(r.attempts.map(a => `${a.provider}:${a.ok}`)).toEqual(['cloudflare:false', 'resend:true'])
    expect(second.sent[0].to).toEqual(['jane@example.com'])
  })

  it('goes out through the second provider when the first adapter throws', async () => {
    const r = await createSender(env, { providers: [memoryProvider('cloudflare', 'throw'), memoryProvider('resend')] }).send(make())
    expect(r).toMatchObject({ ok: true, provider: 'resend' })
  })

  it('counts each attempt of a rescued send to its own provider', async () => {
    const recorder = memoryRecorder()
    await createSender(env, { recorder, providers: [memoryProvider('cloudflare', 'temporary'), memoryProvider('resend')] }).send(make())
    expect(recorder.calls).toHaveLength(1)
    expect(recorder.calls[0].map(a => ({ provider: a.provider, ok: a.ok }))).toEqual([
      { provider: 'cloudflare', ok: false },
      { provider: 'resend', ok: true },
    ])
  })

  it('counts a send that worked first time, once, to the first provider', async () => {
    const recorder = memoryRecorder()
    await createSender(env, { recorder, providers: [memoryProvider('cloudflare'), memoryProvider('resend')] }).send(make())
    expect(recorder.calls).toEqual([[expect.objectContaining({ provider: 'cloudflare', ok: true })]])
  })

  it('treats a suppressed recipient as permanent, counts it, and does not retry it through the other provider', async () => {
    const recorder = memoryRecorder()
    const first = memoryProvider('cloudflare', 'permanent'), second = memoryProvider('resend')
    const r = await createSender(env, { recorder, providers: [first, second] }).send(make())
    expect(r).toMatchObject({ ok: false, provider: 'cloudflare', permanent: true })
    expect(second.sent).toHaveLength(0)
    expect(recorder.calls[0]).toEqual([expect.objectContaining({ provider: 'cloudflare', ok: false, permanent: true })])
  })

  it('reports an outage on both providers as temporary, with one attempt on each and no more', async () => {
    const first = memoryProvider('cloudflare', 'temporary'), second = memoryProvider('resend', 'temporary')
    const r = await createSender(env, { providers: [first, second] }).send(make())
    expect(r).toMatchObject({ ok: false, provider: 'resend', permanent: false })
    expect(first.sent).toHaveLength(1)
    expect(second.sent).toHaveLength(1)
  })

  it('sends from the default From, never the bulk one', async () => {
    const first = memoryProvider('cloudflare')
    await createSender({ ...env, EMAIL_FROM_BULK: 'bulk@mail.example.org' }, { providers: [first] }).send(make())
    expect(first.sent[0].from).toBe('FloorVote <notifications@example.org>')
  })

  it('is suppressed in demo mode by the rule alone: no provider, no count, and not a failure', async () => {
    const first = memoryProvider('cloudflare'), recorder = memoryRecorder()
    const r = await createSender({ ...env, DEMO_MODE: 'true' }, { recorder, providers: [first] }).send(make())
    expect(r).toMatchObject({ ok: true, provider: null, skipped: 'demo-mode' })
    expect(first.sent).toHaveLength(0)
    expect(recorder.calls.flat()).toHaveLength(0)
  })

  it('sends when demo mode is off', async () => {
    const first = memoryProvider('cloudflare')
    expect(await createSender({ ...env, DEMO_MODE: 'false' }, { providers: [first] }).send(make())).toMatchObject({ ok: true })
    expect(first.sent).toHaveLength(1)
  })

  it('fails an invalid address as permanent without calling a provider', async () => {
    const first = memoryProvider('cloudflare')
    const r = await createSender(env, { providers: [first] }).send(make({ to: ['jane@example.gov;'] }))
    expect(r).toMatchObject({ ok: false, provider: null, permanent: true })
    expect(first.sent).toHaveLength(0)
  })

  it('reports a mixed batch per message, with each rescue counted to the provider that sent it', async () => {
    const first: EmailProvider = {
      name: 'cloudflare',
      async send(email) {
        if (email.to[0].startsWith('gone')) return { ok: false, provider: 'cloudflare', error: 'E_RECIPIENT_SUPPRESSED: gone', permanent: true }
        if (email.to[0].startsWith('flaky')) return { ok: false, provider: 'cloudflare', error: 'outage', permanent: false }
        return { ok: true, provider: 'cloudflare', messageId: 'cf' }
      },
    }
    const second = memoryProvider('resend')
    const recorder = memoryRecorder()
    const r = await createSender(env, { recorder, providers: [first, second] }).sendBatch([
      make({ to: ['ok@example.com'] }), make({ to: ['gone@example.com'] }), make({ to: ['flaky@example.com'] }),
    ])
    expect(r).toMatchObject({ sent: 2, failed: 1, skipped: 0 })
    expect(r.results.map(x => (x.ok ? `ok:${x.provider}` : `fail:${x.permanent ? 'permanent' : 'temporary'}`))).toEqual([
      'ok:cloudflare', 'fail:permanent', 'ok:resend',
    ])
    expect(second.sent.map(e => e.to[0])).toEqual(['flaky@example.com'])
    expect(recorder.calls).toHaveLength(1)
    expect(recorder.calls[0].map(a => `${a.provider}:${a.ok}`).sort()).toEqual(['cloudflare:false', 'cloudflare:false', 'cloudflare:true', 'resend:true'])
  })

  it('suppresses a whole batch in demo mode', async () => {
    const first = memoryProvider('cloudflare')
    const r = await createSender({ ...env, DEMO_MODE: 'true' }, { providers: [first] }).sendBatch([make({ to: ['a@example.com'] }), make({ to: ['b@example.com'] })])
    expect(r).toMatchObject({ sent: 0, failed: 0, skipped: 2 })
    expect(first.sent).toHaveLength(0)
  })
})

describe('notification purpose headers', () => {
  it('forwards a reply\'s thread and mute headers unchanged to the provider, and again to the fallback', async () => {
    const first = memoryProvider('cloudflare', 'temporary'), second = memoryProvider('resend')
    const headers = {
      'In-Reply-To': '<bill-1@x.test>', References: '<bill-1@x.test>',
      'List-Unsubscribe': '<https://x.test/api/mute-link?token=t>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    }
    await createSender(env, { providers: [first, second] }).send(notification({ headers }))
    expect(first.sent[0].headers).toEqual(headers)
    expect(second.sent[0].headers).toEqual(headers)
  })
})

describe('purposes apart: one rule does not leak into another', () => {
  it('lets a sign-in login link send in demo mode while account and notification emails do not', async () => {
    const first = memoryProvider('cloudflare')
    const r = await createSender({ ...env, DEMO_MODE: 'true' }, { providers: [first] }).sendBatch([
      signIn({ link: 'login' }), account(), notification(),
    ])
    expect(r).toMatchObject({ sent: 1, failed: 0, skipped: 2 })
  })
})

// The bulk purpose (the digest and the week-ahead email, #708) never falls
// back, so an outage can't burn the other provider's quota. It sends from the
// bulk From address, counts each send to the provider that sent it, and a demo
// instance never sends it.
const bulk = (overrides: Partial<BulkMessage> = {}): BulkMessage => ({
  purpose: 'bulk', to: ['jane@example.com'], subject: 'Your daily digest', html: '<p>Three bills moved</p>',
  headers: { 'List-Unsubscribe': '<https://x.test/profile#setting-email-digest>' },
  ...overrides,
})

describe('bulk purpose: never falls back', () => {
  it('makes one attempt on the first provider and none on the second when the first has an outage', async () => {
    const first = memoryProvider('cloudflare', 'temporary'), second = memoryProvider('resend')
    const r = await createSender(env, { providers: [first, second] }).send(bulk())
    expect(r).toMatchObject({ ok: false, provider: 'cloudflare', permanent: false })
    expect(first.sent).toHaveLength(1)
    expect(second.sent).toHaveLength(0)
    expect(r.attempts.map(a => `${a.provider}:${a.ok}`)).toEqual(['cloudflare:false'])
  })

  it('makes no attempt on the second provider when the first adapter throws', async () => {
    const second = memoryProvider('resend')
    const r = await createSender(env, { providers: [memoryProvider('cloudflare', 'throw'), second] }).send(bulk())
    expect(r).toMatchObject({ ok: false, provider: 'cloudflare', permanent: false })
    expect(second.sent).toHaveLength(0)
  })

  it('counts every failure of a batch to the first provider and never touches the second', async () => {
    const recorder = memoryRecorder()
    const first = memoryProvider('cloudflare', 'temporary'), second = memoryProvider('resend')
    const messages = Array.from({ length: 11 }, (_, i) => bulk({ to: [`u${i}@example.com`] }))
    const r = await createSender(env, { recorder, providers: [first, second] }).sendBatch(messages)
    expect(r).toMatchObject({ sent: 0, failed: 11, skipped: 0 })
    expect(first.sent).toHaveLength(11)
    expect(second.sent).toHaveLength(0)
    expect(recorder.calls).toHaveLength(1)
    expect(recorder.calls[0]).toHaveLength(11)
    expect(recorder.calls[0].every(a => a.provider === 'cloudflare' && !a.ok)).toBe(true)
  })

  it('sends through the first provider alone when it works, even with a second configured', async () => {
    const first = memoryProvider('cloudflare'), second = memoryProvider('resend')
    expect(await createSender(env, { providers: [first, second] }).send(bulk())).toMatchObject({ ok: true, provider: 'cloudflare' })
    expect(first.sent).toHaveLength(1)
    expect(second.sent).toHaveLength(0)
  })

  it('reports a single provider down as one temporary failure', async () => {
    const first = memoryProvider('resend', 'temporary')
    const r = await createSender(env, { providers: [first] }).send(bulk())
    expect(r).toMatchObject({ ok: false, provider: 'resend', permanent: false })
    expect(first.sent).toHaveLength(1)
  })
})

describe('bulk purpose: the bulk From address', () => {
  const withBulk: SenderEnv = { ...env, EMAIL_FROM_BULK: 'notifications@mail.example.org' }

  it('sends from EMAIL_FROM_BULK when it is set', async () => {
    const first = memoryProvider('cloudflare')
    await createSender(withBulk, { providers: [first] }).send(bulk())
    expect(first.sent[0].from).toBe('FloorVote <notifications@mail.example.org>')
  })

  it('sends from EMAIL_FROM when EMAIL_FROM_BULK is unset', async () => {
    const first = memoryProvider('cloudflare')
    await createSender(env, { providers: [first] }).send(bulk())
    expect(first.sent[0].from).toBe('FloorVote <notifications@example.org>')
  })

  it('sends from the example.com fallback when neither is set', async () => {
    const first = memoryProvider('cloudflare')
    await createSender({ DEMO_MODE: 'false' }, { providers: [first] }).send(bulk())
    expect(first.sent[0].from).toBe('FloorVote <notifications@example.com>')
  })

  it('keeps the default Reply-To on the transactional address, not the bulk one', async () => {
    const first = memoryProvider('cloudflare')
    await createSender(withBulk, { providers: [first] }).send(bulk())
    expect(first.sent[0].replyTo).toBe('notifications@example.org')
  })

  it('uses the bulk From for every message of a batch', async () => {
    const first = memoryProvider('cloudflare')
    await createSender(withBulk, { providers: [first] }).sendBatch([bulk({ to: ['a@example.com'] }), bulk({ to: ['b@example.com'] })])
    expect(first.sent.map(e => e.from)).toEqual(Array(2).fill('FloorVote <notifications@mail.example.org>'))
  })

  it('leaves the other purposes on the default From when EMAIL_FROM_BULK is set', async () => {
    const first = memoryProvider('cloudflare')
    await createSender(withBulk, { providers: [first] }).sendBatch([bulk(), notification(), account(), signIn()])
    const bySubject = Object.fromEntries(first.sent.map(e => [e.subject, e.from]))
    expect(bySubject['Your daily digest']).toBe('FloorVote <notifications@mail.example.org>')
    expect(bySubject['[HB 1] New comment']).toBe('FloorVote <notifications@example.org>')
    expect(bySubject['Confirm your new email']).toBe('FloorVote <notifications@example.org>')
    expect(bySubject['Your sign-in link']).toBe('FloorVote <notifications@example.org>')
  })

  it('forwards the unsubscribe header and derives a text part', async () => {
    const first = memoryProvider('cloudflare')
    await createSender(env, { providers: [first] }).send(bulk())
    expect(first.sent[0].headers).toEqual({ 'List-Unsubscribe': '<https://x.test/profile#setting-email-digest>' })
    expect(first.sent[0].text).toContain('Three bills moved')
  })
})

describe('bulk purpose: health counting', () => {
  it('counts a send that worked to the provider that sent it', async () => {
    const recorder = memoryRecorder()
    await createSender(env, { recorder, providers: [memoryProvider('cloudflare'), memoryProvider('resend')] }).send(bulk())
    expect(recorder.calls).toEqual([[expect.objectContaining({ provider: 'cloudflare', ok: true })]])
  })

  it('counts a suppressed recipient as permanent, so it is suppressed and not failed, with no retry', async () => {
    const recorder = memoryRecorder()
    const first = memoryProvider('cloudflare', 'permanent'), second = memoryProvider('resend')
    const r = await createSender(env, { recorder, providers: [first, second] }).send(bulk())
    expect(r).toMatchObject({ ok: false, provider: 'cloudflare', permanent: true })
    expect(second.sent).toHaveLength(0)
    expect(recorder.calls).toEqual([[expect.objectContaining({ provider: 'cloudflare', ok: false, permanent: true })]])
  })

  it('counts nothing when no recorder is supplied, and still sends', async () => {
    const first = memoryProvider('cloudflare')
    expect(await createSender(env, { providers: [first] }).send(bulk())).toMatchObject({ ok: true })
    expect(first.sent).toHaveLength(1)
  })

  it('still reports the send as delivered when the recorder throws', async () => {
    const recorder: HealthRecorder = { async record() { throw new Error('d1 is down') } }
    expect(await createSender(env, { recorder, providers: [memoryProvider('cloudflare')] }).send(bulk())).toMatchObject({ ok: true })
  })

  it('counts a mixed batch per message, each to the provider that sent it, in one recorder call', async () => {
    const first: EmailProvider = {
      name: 'cloudflare',
      async send(email) {
        if (email.to[0].startsWith('gone')) return { ok: false, provider: 'cloudflare', error: 'E_RECIPIENT_SUPPRESSED: gone', permanent: true }
        if (email.to[0].startsWith('flaky')) return { ok: false, provider: 'cloudflare', error: 'outage', permanent: false }
        return { ok: true, provider: 'cloudflare', messageId: 'cf' }
      },
    }
    const second = memoryProvider('resend')
    const recorder = memoryRecorder()
    const r = await createSender(env, { recorder, providers: [first, second] }).sendBatch([
      bulk({ to: ['ok@example.com'] }), bulk({ to: ['gone@example.com'] }), bulk({ to: ['flaky@example.com'] }), bulk({ to: ['not-an-address'] }),
    ])
    expect(r).toMatchObject({ sent: 1, failed: 3, skipped: 0 })
    expect(r.results.map(x => (x.ok ? `ok:${x.provider}` : `fail:${x.permanent ? 'permanent' : 'temporary'}`))).toEqual([
      'ok:cloudflare', 'fail:permanent', 'fail:temporary', 'fail:permanent',
    ])
    // The flaky recipient is not retried on the second provider, and the bad address never reaches one.
    expect(second.sent).toHaveLength(0)
    expect(recorder.calls).toHaveLength(1)
    expect(recorder.calls[0].map(a => `${a.provider}:${a.ok}:${!a.ok && a.permanent}`).sort()).toEqual([
      'cloudflare:false:false', 'cloudflare:false:true', 'cloudflare:true:false',
    ])
  })
})

describe('bulk purpose: demo mode and addresses', () => {
  it('is suppressed in demo mode by the rule alone: no provider, no count, and not a failure', async () => {
    const first = memoryProvider('cloudflare'), recorder = memoryRecorder()
    const r = await createSender({ ...env, DEMO_MODE: 'true' }, { recorder, providers: [first] }).send(bulk())
    expect(r).toMatchObject({ ok: true, provider: null, skipped: 'demo-mode' })
    expect(first.sent).toHaveLength(0)
    expect(recorder.calls.flat()).toHaveLength(0)
  })

  it('suppresses a whole batch in demo mode', async () => {
    const first = memoryProvider('cloudflare'), recorder = memoryRecorder()
    const r = await createSender({ ...env, DEMO_MODE: 'true' }, { recorder, providers: [first] }).sendBatch([bulk({ to: ['a@example.com'] }), bulk({ to: ['b@example.com'] })])
    expect(r).toMatchObject({ sent: 0, failed: 0, skipped: 2 })
    expect(first.sent).toHaveLength(0)
    expect(recorder.calls.flat()).toHaveLength(0)
  })

  it('sends when demo mode is off', async () => {
    const first = memoryProvider('cloudflare')
    expect(await createSender({ ...env, DEMO_MODE: 'false' }, { providers: [first] }).send(bulk())).toMatchObject({ ok: true })
    expect(first.sent).toHaveLength(1)
  })

  it('fails an invalid address as permanent without calling a provider', async () => {
    const first = memoryProvider('cloudflare')
    const r = await createSender(env, { providers: [first] }).send(bulk({ to: ['jane@example.gov;'] }))
    expect(r).toMatchObject({ ok: false, provider: null, permanent: true })
    expect(first.sent).toHaveLength(0)
  })

  it('sends more messages than the concurrency bound, each exactly once, all from the bulk From', async () => {
    const first = memoryProvider('cloudflare')
    const messages = Array.from({ length: 21 }, (_, i) => bulk({ to: [`u${i}@example.com`] }))
    const r = await createSender({ ...env, EMAIL_FROM_BULK: 'notifications@mail.example.org' }, { providers: [first] }).sendBatch(messages)
    expect(r.sent).toBe(21)
    expect(new Set(first.sent.map(e => e.to[0])).size).toBe(21)
    expect(first.sent.every(e => e.from === 'FloorVote <notifications@mail.example.org>')).toBe(true)
  })

  it('returns an empty batch without counting', async () => {
    const recorder = memoryRecorder()
    expect(await createSender(env, { recorder, providers: [memoryProvider('cloudflare')] }).sendBatch([])).toEqual({ sent: 0, failed: 0, skipped: 0, results: [] })
    expect(recorder.calls).toHaveLength(0)
  })
})

describe('purposes apart: bulk does not leak into the others', () => {
  it('falls back for a notification while a bulk message in the same batch does not', async () => {
    const first = memoryProvider('cloudflare', 'temporary'), second = memoryProvider('resend')
    const r = await createSender({ ...env, DEMO_MODE: 'false' }, { providers: [first, second] }).sendBatch([
      bulk({ to: ['digest@example.com'] }), notification({ to: ['note@example.com'] }),
    ])
    expect(r.results.map(x => (x.ok ? `ok:${x.provider}` : 'fail'))).toEqual(['fail', 'ok:resend'])
    expect(second.sent.map(e => e.to[0])).toEqual(['note@example.com'])
  })
})

// The operator purpose (feedback, invite-bounce notices, job alerts, and sample
// emails, #709) falls back, never counts toward email health, and sends in
// demo mode. The outage alert is the same, except that it tries the healthy
// provider first: the provider the alert is about is the primary, and the
// alert can't count on it to carry the news.
const operator = (overrides: Partial<OperatorMessage> = {}): OperatorMessage => ({
  purpose: 'operator', to: ['ops@example.com'], subject: 'Feedback from a member', html: '<p>Great tool</p>',
  ...overrides,
})

const outageAlert = (overrides: Partial<OutageAlertMessage> = {}): OutageAlertMessage => ({
  purpose: 'outage-alert', to: ['ops@example.com'], subject: 'Email sending is failing', html: '<p>cloudflare is failing</p>',
  ...overrides,
})

describe('operator purpose: delivery and fallback', () => {
  it('sends through the first provider and leaves the second alone', async () => {
    const first = memoryProvider('cloudflare'), second = memoryProvider('resend'), recorder = memoryRecorder()
    const r = await createSender(env, { recorder, providers: [first, second] }).send(operator())
    expect(r).toMatchObject({ ok: true, provider: 'cloudflare' })
    expect(first.sent).toHaveLength(1)
    expect(second.sent).toHaveLength(0)
    expect(recorder.calls).toEqual([])
  })

  it('goes out through the second provider when the first has an outage', async () => {
    const first = memoryProvider('cloudflare', 'temporary'), second = memoryProvider('resend')
    const r = await createSender(env, { providers: [first, second] }).send(operator())
    expect(r).toMatchObject({ ok: true, provider: 'resend' })
    expect(r.attempts.map(a => `${a.provider}:${a.ok}`)).toEqual(['cloudflare:false', 'resend:true'])
    expect(second.sent[0].to).toEqual(['ops@example.com'])
  })

  it('goes out through the second provider when the first adapter throws', async () => {
    const r = await createSender(env, { providers: [memoryProvider('cloudflare', 'throw'), memoryProvider('resend')] }).send(operator())
    expect(r).toMatchObject({ ok: true, provider: 'resend' })
  })

  it('does not retry a suppressed recipient through the other provider, and counts nothing', async () => {
    const first = memoryProvider('cloudflare', 'permanent'), second = memoryProvider('resend'), recorder = memoryRecorder()
    const r = await createSender(env, { recorder, providers: [first, second] }).send(operator())
    expect(r).toMatchObject({ ok: false, provider: 'cloudflare', permanent: true })
    expect(second.sent).toHaveLength(0)
    expect(recorder.calls).toEqual([])
  })

  it('reports an outage on both providers as temporary, with one attempt on each and no more', async () => {
    const first = memoryProvider('cloudflare', 'temporary'), second = memoryProvider('resend', 'temporary')
    const r = await createSender(env, { providers: [first, second] }).send(operator())
    expect(r).toMatchObject({ ok: false, provider: 'resend', permanent: false, error: 'outage' })
    expect(first.sent).toHaveLength(1)
    expect(second.sent).toHaveLength(1)
  })

  it('makes one attempt and reports temporary when only one provider is configured', async () => {
    const only = memoryProvider('resend', 'temporary'), recorder = memoryRecorder()
    const r = await createSender(env, { recorder, providers: [only] }).send(operator())
    expect(r).toMatchObject({ ok: false, provider: 'resend', permanent: false })
    expect(only.sent).toHaveLength(1)
    expect(recorder.calls).toEqual([])
  })

  it('fails an invalid address as permanent without calling a provider', async () => {
    const first = memoryProvider('cloudflare'), second = memoryProvider('resend')
    const r = await createSender(env, { providers: [first, second] }).send(operator({ to: ['ops@example.gov;'] }))
    expect(r).toMatchObject({ ok: false, provider: null, permanent: true })
    expect(first.sent).toHaveLength(0)
    expect(second.sent).toHaveLength(0)
  })

  it('sends from the default From, never the bulk one, with the default Reply-To', async () => {
    const first = memoryProvider('cloudflare')
    await createSender({ ...env, EMAIL_FROM_BULK: 'notifications@mail.example.org' }, { providers: [first] }).send(operator())
    expect(first.sent[0].from).toBe('FloorVote <notifications@example.org>')
    expect(first.sent[0].replyTo).toBe('notifications@example.org')
  })

  it('derives a text part from the html when none is given, and keeps a hand-written one', async () => {
    const first = memoryProvider('cloudflare')
    await createSender(env, { providers: [first] }).sendBatch([operator(), operator({ text: 'hand-written' })])
    expect(first.sent.map(e => e.text)).toEqual([expect.stringContaining('Great tool'), 'hand-written'])
  })
})

describe('operator purpose: never counts toward email health', () => {
  it('counts nothing for a send that worked', async () => {
    const recorder = memoryRecorder()
    await createSender(env, { recorder, providers: [memoryProvider('cloudflare')] }).send(operator())
    expect(recorder.calls).toEqual([])
  })

  it('counts nothing for a send that fallback rescued, neither the failed first attempt nor the rescue', async () => {
    const recorder = memoryRecorder()
    const r = await createSender(env, { recorder, providers: [memoryProvider('cloudflare', 'temporary'), memoryProvider('resend')] }).send(operator())
    expect(r).toMatchObject({ ok: true, provider: 'resend' })
    expect(recorder.calls).toEqual([])
  })

  it('counts nothing for a failure on both providers', async () => {
    const recorder = memoryRecorder()
    await createSender(env, { recorder, providers: [memoryProvider('cloudflare', 'temporary'), memoryProvider('resend', 'temporary')] }).send(operator())
    expect(recorder.calls).toEqual([])
  })

  it('counts nothing for a whole batch of operator mail', async () => {
    const recorder = memoryRecorder()
    const r = await createSender(env, { recorder, providers: [memoryProvider('cloudflare', 'temporary'), memoryProvider('resend')] }).sendBatch([
      operator({ to: ['a@example.com'] }), operator({ to: ['b@example.com'] }),
    ])
    expect(r).toMatchObject({ sent: 2, failed: 0, skipped: 0 })
    expect(recorder.calls).toEqual([])
  })

  it('counts a member-bound message in the same batch and not the operator message beside it', async () => {
    const recorder = memoryRecorder()
    await createSender(env, { recorder, providers: [memoryProvider('cloudflare')] }).sendBatch([operator(), notification()])
    expect(recorder.calls).toHaveLength(1)
    expect(recorder.calls[0]).toHaveLength(1)
  })
})

describe('operator purpose: demo mode', () => {
  const demo: SenderEnv = { ...env, DEMO_MODE: 'true' }

  it('sends in demo mode', async () => {
    const first = memoryProvider('cloudflare')
    const r = await createSender(demo, { providers: [first] }).send(operator())
    expect(r).toMatchObject({ ok: true, provider: 'cloudflare' })
    expect(r).not.toHaveProperty('skipped')
    expect(first.sent).toHaveLength(1)
  })

  it('still falls back in demo mode', async () => {
    const r = await createSender(demo, { providers: [memoryProvider('cloudflare', 'temporary'), memoryProvider('resend')] }).send(operator())
    expect(r).toMatchObject({ ok: true, provider: 'resend' })
  })

  it('sends a whole batch in demo mode, while bulk mail beside it is suppressed', async () => {
    const first = memoryProvider('cloudflare')
    const r = await createSender(demo, { providers: [first] }).sendBatch([operator({ to: ['a@example.com'] }), bulk(), operator({ to: ['b@example.com'] })])
    expect(r).toMatchObject({ sent: 2, failed: 0, skipped: 1 })
    expect(first.sent.map(e => e.to[0])).toEqual(['a@example.com', 'b@example.com'])
  })
})

describe('operator purpose: does not leak into the others', () => {
  it('leaves a bulk message without fallback and an account message suppressed in demo mode', async () => {
    const first = memoryProvider('cloudflare', 'temporary'), second = memoryProvider('resend')
    const r = await createSender(env, { providers: [first, second] }).sendBatch([bulk({ to: ['digest@example.com'] }), operator({ to: ['ops@example.com'] })])
    expect(r.results.map(x => (x.ok ? `ok:${x.provider}` : 'fail'))).toEqual(['fail', 'ok:resend'])
    expect(second.sent.map(e => e.to[0])).toEqual(['ops@example.com'])
    const demoRun = await createSender({ ...env, DEMO_MODE: 'true' }, { providers: [memoryProvider('cloudflare')] }).sendBatch([account(), operator()])
    expect(demoRun).toMatchObject({ sent: 1, failed: 0, skipped: 1 })
  })

  it('uses the bulk From for bulk mail and the default From for operator mail in one batch', async () => {
    const first = memoryProvider('cloudflare')
    await createSender({ ...env, EMAIL_FROM_BULK: 'notifications@mail.example.org' }, { providers: [first] }).sendBatch([bulk(), operator()])
    const bySubject = Object.fromEntries(first.sent.map(e => [e.subject, e.from]))
    expect(bySubject['Your daily digest']).toBe('FloorVote <notifications@mail.example.org>')
    expect(bySubject['Feedback from a member']).toBe('FloorVote <notifications@example.org>')
  })
})

describe('outage-alert purpose: the healthy provider first', () => {
  // The providers are [the failing primary, the healthy other], as the sender
  // is given them. The alert is about the first, so the rule sends it through
  // the second.
  it('goes out through the healthy provider first, leaving the failing one untouched', async () => {
    const failing = memoryProvider('cloudflare', 'temporary'), healthy = memoryProvider('resend')
    const r = await createSender(env, { providers: [failing, healthy] }).send(outageAlert())
    expect(r).toMatchObject({ ok: true, provider: 'resend' })
    expect(healthy.sent).toHaveLength(1)
    expect(failing.sent).toHaveLength(0)
    expect(r.attempts.map(a => `${a.provider}:${a.ok}`)).toEqual(['resend:true'])
  })

  it('goes out through the healthy provider first whichever provider is the failing one', async () => {
    const failing = memoryProvider('resend', 'temporary'), healthy = memoryProvider('cloudflare')
    const r = await createSender(env, { providers: [failing, healthy] }).send(outageAlert())
    expect(r).toMatchObject({ ok: true, provider: 'cloudflare' })
    expect(failing.sent).toHaveLength(0)
  })

  it('falls back to the failing provider when the healthy one is rejected, trying the healthy one first', async () => {
    const failing = memoryProvider('cloudflare'), healthy = memoryProvider('resend', 'temporary')
    const r = await createSender(env, { providers: [failing, healthy] }).send(outageAlert())
    expect(r).toMatchObject({ ok: true, provider: 'cloudflare' })
    expect(r.attempts.map(a => `${a.provider}:${a.ok}`)).toEqual(['resend:false', 'cloudflare:true'])
  })

  it('falls back to the failing provider when the healthy adapter throws', async () => {
    const r = await createSender(env, { providers: [memoryProvider('cloudflare'), memoryProvider('resend', 'throw')] }).send(outageAlert())
    expect(r).toMatchObject({ ok: true, provider: 'cloudflare' })
    expect(r.attempts.map(a => a.provider)).toEqual(['resend', 'cloudflare'])
  })

  it('reports temporary after one attempt on each, the healthy one first, when both providers are down', async () => {
    const failing = memoryProvider('cloudflare', 'temporary'), healthy = memoryProvider('resend', 'temporary')
    const r = await createSender(env, { providers: [failing, healthy] }).send(outageAlert())
    expect(r).toMatchObject({ ok: false, provider: 'cloudflare', permanent: false })
    expect(r.attempts.map(a => a.provider)).toEqual(['resend', 'cloudflare'])
    expect(failing.sent).toHaveLength(1)
    expect(healthy.sent).toHaveLength(1)
  })

  it('does not retry a suppressed recipient through the failing provider', async () => {
    const failing = memoryProvider('cloudflare'), healthy = memoryProvider('resend', 'permanent')
    const r = await createSender(env, { providers: [failing, healthy] }).send(outageAlert())
    expect(r).toMatchObject({ ok: false, provider: 'resend', permanent: true })
    expect(failing.sent).toHaveLength(0)
  })

  it('makes one attempt on the only configured provider, and counts nothing', async () => {
    const only = memoryProvider('cloudflare', 'temporary'), recorder = memoryRecorder()
    const r = await createSender(env, { recorder, providers: [only] }).send(outageAlert())
    expect(r).toMatchObject({ ok: false, provider: 'cloudflare', permanent: false })
    expect(only.sent).toHaveLength(1)
    expect(recorder.calls).toEqual([])
  })

  it('sends through the only configured provider when it works', async () => {
    const only = memoryProvider('resend')
    expect(await createSender(env, { providers: [only] }).send(outageAlert())).toMatchObject({ ok: true, provider: 'resend' })
    expect(only.sent).toHaveLength(1)
  })

  it('orders a batch the same way, message by message', async () => {
    const failing = memoryProvider('cloudflare', 'temporary'), healthy = memoryProvider('resend')
    const r = await createSender(env, { providers: [failing, healthy] }).sendBatch([outageAlert({ to: ['a@example.com'] }), outageAlert({ to: ['b@example.com'] })])
    expect(r).toMatchObject({ sent: 2, failed: 0 })
    expect(failing.sent).toHaveLength(0)
    expect(healthy.sent.map(e => e.to[0])).toEqual(['a@example.com', 'b@example.com'])
  })

  it('leaves the order of every other purpose alone: operator mail tries the first provider first', async () => {
    const first = memoryProvider('cloudflare'), second = memoryProvider('resend')
    await createSender(env, { providers: [first, second] }).sendBatch([operator(), notification(), account(), signIn()])
    expect(first.sent).toHaveLength(4)
    expect(second.sent).toHaveLength(0)
  })
})

describe('outage-alert purpose: never counts, and sends in demo mode', () => {
  it('counts nothing for an alert the healthy provider carried', async () => {
    const recorder = memoryRecorder()
    await createSender(env, { recorder, providers: [memoryProvider('cloudflare', 'temporary'), memoryProvider('resend')] }).send(outageAlert())
    expect(recorder.calls).toEqual([])
  })

  it('counts nothing for an alert that needed both providers, so it cannot fake a recovery', async () => {
    const recorder = memoryRecorder()
    await createSender(env, { recorder, providers: [memoryProvider('cloudflare'), memoryProvider('resend', 'temporary')] }).send(outageAlert())
    expect(recorder.calls).toEqual([])
  })

  it('sends in demo mode', async () => {
    const failing = memoryProvider('cloudflare', 'temporary'), healthy = memoryProvider('resend')
    const r = await createSender({ ...env, DEMO_MODE: 'true' }, { providers: [failing, healthy] }).send(outageAlert())
    expect(r).toMatchObject({ ok: true, provider: 'resend' })
    expect(r).not.toHaveProperty('skipped')
    expect(healthy.sent).toHaveLength(1)
  })

  it('sends from the default From, never the bulk one', async () => {
    const healthy = memoryProvider('resend')
    await createSender({ ...env, EMAIL_FROM_BULK: 'notifications@mail.example.org' }, { providers: [memoryProvider('cloudflare'), healthy] }).send(outageAlert())
    expect(healthy.sent[0].from).toBe('FloorVote <notifications@example.org>')
  })

  it('fails an invalid address as permanent without calling a provider', async () => {
    const failing = memoryProvider('cloudflare'), healthy = memoryProvider('resend')
    const r = await createSender(env, { providers: [failing, healthy] }).send(outageAlert({ to: ['not-an-address'] }))
    expect(r).toMatchObject({ ok: false, provider: null, permanent: true })
    expect(failing.sent).toHaveLength(0)
    expect(healthy.sent).toHaveLength(0)
  })
})
