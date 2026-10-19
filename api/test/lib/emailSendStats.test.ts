import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { env } from 'cloudflare:test'
import { resetDb, applyMigrations } from '../helpers'
import { getDb } from '../../src/db/client'
import { emailSendStats } from '../../src/db/schema'
import { sendEmail, sendBatch, senderFor } from '../../src/lib/email'

const msg = (to: string) => ({ to: [to], subject: 'Hi', html: '<p>x</p>' })

describe('sends are counted in email_send_stats', () => {
  beforeEach(async () => { await resetDb(); await applyMigrations() })
  afterEach(() => { vi.unstubAllGlobals() })

  it('sendEmail counts each attempt of a rescued send against its own provider', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ id: 'rs-1' }), { status: 200 })))
    const db = getDb(env.DB)
    const e = {
      EMAIL_PROVIDER: 'cloudflare', RESEND_API_KEY: 'k',
      EMAIL: { send: vi.fn(async () => { throw Object.assign(new Error('x'), { code: 'E_RECIPIENT_NOT_ALLOWED' }) }) },
    }
    await sendEmail(e as never, msg('a@b.com'), db, { fallback: true })
    const rows = await db.select().from(emailSendStats).all()
    const by = Object.fromEntries(rows.map(r => [r.provider, r]))
    expect(by.cloudflare).toMatchObject({ sent: 0, failed: 1, suppressed: 0 })
    expect(by.cloudflare.lastError).toContain('E_RECIPIENT_NOT_ALLOWED')
    expect(by.resend).toMatchObject({ sent: 1, failed: 0 })
  })

  it('sendEmail without a db writes nothing and still sends', async () => {
    const e = { EMAIL_PROVIDER: 'cloudflare', EMAIL: { send: vi.fn(async () => ({ messageId: 'm' })) } }
    const r = await sendEmail(e as never, msg('a@b.com'))
    expect(r.ok).toBe(true)
    expect(await getDb(env.DB).select().from(emailSendStats).all()).toHaveLength(0)
  })

  it('sendBatch writes one aggregated row for the whole run', async () => {
    const db = getDb(env.DB)
    let n = 0
    const e = {
      EMAIL_PROVIDER: 'cloudflare', DEMO_MODE: 'false',
      EMAIL: { send: vi.fn(async () => {
        n++
        if (n % 3 === 0) throw Object.assign(new Error('x'), { code: 'E_RECIPIENT_SUPPRESSED' })
        if (n % 5 === 0) throw Object.assign(new Error('y'), { code: 'E_RATE_LIMIT_EXCEEDED' })
        return { messageId: 'm' }
      }) },
    }
    const messages = Array.from({ length: 20 }, (_, i) => msg(`u${i}@b.com`))
    const r = await sendBatch(e as never, messages, 'digest', db, { bulk: true })
    const rows = await db.select().from(emailSendStats).all()
    expect(rows).toHaveLength(1)
    // n = 1..20: multiples of 3 are suppressed (6), multiples of 5 not of 3 fail (5, 10, 20)
    expect(rows[0]).toMatchObject({ provider: 'cloudflare', sent: 11, suppressed: 6, failed: 3 })
    expect(r).toEqual({ sent: 11, failed: 9 })
  })

  it('a bulk batch writes one aggregated row for the whole run, with no fallback to the second provider', async () => {
    const db = getDb(env.DB)
    const fetchStub = vi.fn(async () => new Response(JSON.stringify({ id: 'rs-1' }), { status: 200 }))
    vi.stubGlobal('fetch', fetchStub)
    let n = 0
    const e = {
      EMAIL_PROVIDER: 'cloudflare', RESEND_API_KEY: 'k', DEMO_MODE: 'false',
      EMAIL: { send: vi.fn(async () => {
        n++
        if (n % 3 === 0) throw Object.assign(new Error('x'), { code: 'E_RECIPIENT_SUPPRESSED' })
        if (n % 5 === 0) throw Object.assign(new Error('y'), { code: 'E_RATE_LIMIT_EXCEEDED' })
        return { messageId: 'm' }
      }) },
    }
    const messages = Array.from({ length: 20 }, (_, i) => ({ purpose: 'bulk' as const, to: [`u${i}@b.com`], subject: 'Hi', html: '<p>x</p>' }))
    const r = await senderFor(e as never, db).sendBatch(messages)
    const rows = await db.select().from(emailSendStats).all()
    expect(rows).toHaveLength(1)
    // n = 1..20: multiples of 3 are suppressed (6), multiples of 5 not of 3 fail (5, 10, 20)
    expect(rows[0]).toMatchObject({ provider: 'cloudflare', sent: 11, suppressed: 6, failed: 3 })
    expect(fetchStub).not.toHaveBeenCalled()
    // Same totals as the old sendBatch: a suppressed recipient is not a sent one.
    expect(r).toMatchObject({ sent: 11, failed: 9, skipped: 0 })
  })

  it('a bulk batch counts nothing in demo mode and calls no provider', async () => {
    const db = getDb(env.DB)
    const e = { EMAIL_PROVIDER: 'cloudflare', DEMO_MODE: 'true', EMAIL: { send: vi.fn(async () => ({ messageId: 'm' })) } }
    const r = await senderFor(e as never, db).sendBatch([{ purpose: 'bulk', to: ['a@b.com'], subject: 'Hi', html: '<p>x</p>' }])
    expect(r).toMatchObject({ sent: 0, failed: 0, skipped: 1 })
    expect(e.EMAIL.send).not.toHaveBeenCalled()
    expect(await db.select().from(emailSendStats).all()).toHaveLength(0)
  })
})
