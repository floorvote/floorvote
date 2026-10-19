import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  memoryProvider, memoryRecorder, fakeSender, fakeBinding, stubResend, RESEND_KEY, bothBindingFirst, bothResendFirst,
} from './emailTestKit'
import type { OutgoingEmail } from './emailProviders'

// The one set of fakes every email test shares (#711): in-memory providers and
// a recorder for the sender's own tests, a fake sender for callers' tests, and
// transport fakes (the binding, Resend over fetch) for the few tests that run
// a real adapter. These tests pin what the fakes promise, so a drifting fake
// can't quietly change what the other tests prove.

const email: OutgoingEmail = { to: ['a@example.com'], from: 'F <f@example.com>', replyTo: 'f@example.com', subject: 's', html: '<p>h</p>', text: 'h' }

afterEach(() => vi.restoreAllMocks())

describe('memoryProvider', () => {
  it('records each message and answers ok with an id numbered by how many it has sent', async () => {
    const p = memoryProvider('resend')
    expect(await p.send(email)).toEqual({ ok: true, provider: 'resend', messageId: 'resend-1' })
    expect(await p.send(email)).toEqual({ ok: true, provider: 'resend', messageId: 'resend-2' })
    expect(p.sent).toHaveLength(2)
    expect(p.name).toBe('resend')
  })

  it('answers a temporary failure and a permanent one, each classified', async () => {
    expect(await memoryProvider('cloudflare', 'temporary').send(email)).toEqual({ ok: false, provider: 'cloudflare', error: 'outage', permanent: false })
    expect(await memoryProvider('cloudflare', 'permanent').send(email)).toEqual({ ok: false, provider: 'cloudflare', error: 'E_RECIPIENT_SUPPRESSED: gone', permanent: true })
  })

  it('throws, like a broken adapter, for the throw outcome', async () => {
    await expect(memoryProvider('resend', 'throw').send(email)).rejects.toThrow('resend adapter blew up')
  })

  it('walks a list of outcomes in order and repeats the last', async () => {
    const p = memoryProvider('resend', ['temporary', 'ok'])
    expect((await p.send(email)).ok).toBe(false)
    expect((await p.send(email)).ok).toBe(true)
    expect((await p.send(email)).ok).toBe(true)
  })
})

describe('memoryRecorder', () => {
  it('keeps every call of attempts, in order', async () => {
    const r = memoryRecorder()
    await r.record([{ ok: true, provider: 'resend' }])
    await r.record([{ ok: false, provider: 'cloudflare', error: 'x', permanent: false }])
    expect(r.calls.map(c => c.map(a => a.provider))).toEqual([['resend'], ['cloudflare']])
  })
})

describe('fakeSender', () => {
  const login = { purpose: 'sign-in' as const, link: 'login' as const, to: ['a@example.com'], subject: 's', html: '<p>h</p>' }
  const bulk = { purpose: 'bulk' as const, to: ['b@example.com'], subject: 's', html: '<p>h</p>' }
  const note = { purpose: 'notification' as const, to: ['c@example.com'], subject: 's', html: '<p>h</p>' }

  it('answers a send as delivered by default', async () => {
    const s = fakeSender()
    expect(await s.send(login)).toEqual({ ok: true, provider: 'resend', attempts: [] })
  })

  it('answers a batch as all delivered by default, counting messages', async () => {
    const s = fakeSender()
    expect(await s.sendBatch([bulk, note, bulk])).toEqual({ sent: 3, failed: 0, skipped: 0, results: [] })
  })

  it('records every message with its purpose, across sends and batches, in the order they were handed over', async () => {
    const s = fakeSender()
    await s.send(login)
    await s.sendBatch([bulk, note])
    await s.send(bulk)
    expect(s.sent().map(m => m.purpose)).toEqual(['sign-in', 'bulk', 'notification', 'bulk'])
  })

  it('lets a test choose the answer, and still records what it was asked', async () => {
    const s = fakeSender()
    s.send.mockResolvedValue({ ok: false, provider: 'resend', error: 'down', permanent: false, attempts: [] })
    s.sendBatch.mockResolvedValue({ sent: 1, failed: 1, skipped: 1, results: [] })
    expect((await s.send(login)).ok).toBe(false)
    expect(await s.sendBatch([bulk])).toMatchObject({ sent: 1, failed: 1, skipped: 1 })
    expect(s.sent()).toHaveLength(2)
  })

  it('lets a test make the send throw', async () => {
    const s = fakeSender()
    s.send.mockRejectedValue(new Error('boom'))
    await expect(s.send(login)).rejects.toThrow('boom')
  })

  it('forgets what it recorded and goes back to its defaults on reset', async () => {
    const s = fakeSender()
    s.send.mockResolvedValue({ ok: false, provider: null, error: 'x', permanent: true, attempts: [] })
    await s.send(login)
    s.reset()
    expect(s.sent()).toEqual([])
    expect((await s.send(login)).ok).toBe(true)
  })
})

describe('fakeBinding', () => {
  const msg = { to: 'a@example.com', from: 'f@example.com', subject: 's', html: '<p>h</p>' }

  it('resolves with a numbered message id and records the message', async () => {
    const { sent, binding } = fakeBinding()
    expect(await binding.send(msg)).toEqual({ messageId: 'cf-1' })
    expect(sent).toEqual([msg])
  })

  it('records a message even when it then fails', async () => {
    const { sent, binding } = fakeBinding('down')
    await expect(binding.send(msg)).rejects.toMatchObject({ code: 'E_INTERNAL_SERVER_ERROR', message: 'binding is down' })
    expect(sent).toHaveLength(1)
  })

  it('rejects with the suppression code for a suppressed recipient', async () => {
    await expect(fakeBinding('suppressed').binding.send(msg)).rejects.toMatchObject({ code: 'E_RECIPIENT_SUPPRESSED' })
  })

  it('throws synchronously, before returning a promise, in throw-sync mode', () => {
    expect(() => fakeBinding('throw-sync').binding.send(msg)).toThrow('binding threw synchronously')
  })

  it('rejects with the error a test supplies when it is down', async () => {
    const { binding } = fakeBinding('down', { message: 'binding exploded: detail', code: 'E_SENDER_NOT_VERIFIED' })
    await expect(binding.send(msg)).rejects.toMatchObject({ message: 'binding exploded: detail', code: 'E_SENDER_NOT_VERIFIED' })
  })
})

describe('fakeBinding: what it accepted, and different answers per call', () => {
  const msg = (to: string) => ({ to, from: 'f@example.com', subject: 's', html: '<p>h</p>' })

  it('keeps the messages it accepted apart from every message it was handed', async () => {
    const { sent, delivered, binding } = fakeBinding(['down', 'ok', 'suppressed', 'ok'])
    await binding.send(msg('a@example.com')).catch(() => {})
    await binding.send(msg('b@example.com'))
    await binding.send(msg('c@example.com')).catch(() => {})
    await binding.send(msg('d@example.com'))
    expect(sent.map(m => m.to)).toEqual(['a@example.com', 'b@example.com', 'c@example.com', 'd@example.com'])
    expect(delivered.map(m => m.to)).toEqual(['b@example.com', 'd@example.com'])
  })

  it('numbers the message ids of the messages it accepted, so a rescued send does not skip one', async () => {
    const { binding } = fakeBinding(['down', 'ok', 'ok'])
    await binding.send(msg('a@example.com')).catch(() => {})
    expect(await binding.send(msg('b@example.com'))).toEqual({ messageId: 'cf-1' })
    expect(await binding.send(msg('c@example.com'))).toEqual({ messageId: 'cf-2' })
  })

  it('walks a list of modes in order and repeats the last, as memoryProvider walks its outcomes', async () => {
    const { binding } = fakeBinding(['down', 'ok'])
    await expect(binding.send(msg('a@example.com'))).rejects.toMatchObject({ code: 'E_INTERNAL_SERVER_ERROR' })
    await expect(binding.send(msg('b@example.com'))).resolves.toBeDefined()
    await expect(binding.send(msg('c@example.com'))).resolves.toBeDefined()
  })

  it('lets a function pick the mode from the message and the call number, for a different answer per recipient', async () => {
    const { binding, delivered } = fakeBinding((m, n) => (m.to === 'bad@example.com' ? 'suppressed' : n === 1 ? 'down' : 'ok'))
    await expect(binding.send(msg('x@example.com'))).rejects.toMatchObject({ code: 'E_INTERNAL_SERVER_ERROR' })
    await expect(binding.send(msg('bad@example.com'))).rejects.toMatchObject({ code: 'E_RECIPIENT_SUPPRESSED' })
    await expect(binding.send(msg('y@example.com'))).resolves.toBeDefined()
    expect(delivered.map(m => m.to)).toEqual(['y@example.com'])
  })

  it('throws synchronously for a throw-sync entry in a list, and delivers nothing', () => {
    const { binding, delivered } = fakeBinding(['throw-sync'])
    expect(() => binding.send(msg('a@example.com'))).toThrow('binding threw synchronously')
    expect(delivered).toHaveLength(0)
  })

  it('uses the failure a test supplies for every down entry', async () => {
    const { binding } = fakeBinding(['ok', 'down'], { message: 'nope', code: 'E_RATE_LIMIT_EXCEEDED' })
    await binding.send(msg('a@example.com'))
    await expect(binding.send(msg('b@example.com'))).rejects.toMatchObject({ message: 'nope', code: 'E_RATE_LIMIT_EXCEEDED' })
  })
})

describe('stubResend', () => {
  const post = () => fetch('https://api.resend.com/emails', {
    method: 'POST', headers: { Authorization: `Bearer ${RESEND_KEY}` },
    body: JSON.stringify({ from: 'f', to: ['a@example.com'], subject: 's', html: 'h', text: 't', reply_to: 'r' }),
  })

  it('answers ok with a numbered id, and records the url, key, and body', async () => {
    const resend = stubResend()
    const res = await post()
    expect(await res.json()).toEqual({ id: 're-1' })
    expect(resend.calls).toHaveLength(1)
    expect(resend.calls[0]).toMatchObject({ url: 'https://api.resend.com/emails', auth: `Bearer ${RESEND_KEY}`, body: { to: ['a@example.com'] } })
  })

  it('answers 503 when down, with a status and body a test can override', async () => {
    stubResend('down')
    expect((await post()).status).toBe(503)
    stubResend('down', { status: 500, body: 'internal detail' })
    const res = await post()
    expect(res.status).toBe(500)
    expect(await res.text()).toBe('internal detail')
  })

  it('adds the response headers a test asks for, to an ok answer or a down one', async () => {
    stubResend('ok', { headers: { 'x-resend-monthly-quota': '812' } })
    expect((await post()).headers.get('x-resend-monthly-quota')).toBe('812')
    stubResend('down', { headers: { 'x-resend-daily-quota': '40' } })
    const res = await post()
    expect(res.status).toBe(503)
    expect(res.headers.get('x-resend-daily-quota')).toBe('40')
  })

  it('throws a network error in throw mode', async () => {
    stubResend('throw')
    await expect(post()).rejects.toThrow('network unreachable')
  })
})

describe('provider env presets', () => {
  it('puts the binding first, or Resend first, with both configured', () => {
    const binding = { send: async () => ({}) }
    expect(bothBindingFirst(binding)).toEqual({ EMAIL_PROVIDER: 'cloudflare', EMAIL: binding, RESEND_API_KEY: RESEND_KEY })
    expect(bothResendFirst(binding)).toEqual({ EMAIL: binding, RESEND_API_KEY: RESEND_KEY })
  })
})
