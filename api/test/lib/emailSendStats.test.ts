import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { env } from 'cloudflare:test'
import { resetDb, applyMigrations } from '../helpers'
import { getDb } from '../../src/db/client'
import { emailSendStats } from '../../src/db/schema'
import { senderFor } from '../../src/lib/email'
import { fakeBinding, stubResend } from '../../../shared/emailTestKit'

const msg = (to: string) => ({ to: [to], subject: 'Hi', html: '<p>x</p>' })

describe('sends are counted in email_send_stats', () => {
  beforeEach(async () => { await resetDb(); await applyMigrations() })
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

  it('a send counts each attempt of a rescued send against its own provider', async () => {
    stubResend()
    const db = getDb(env.DB)
    const e = {
      EMAIL_PROVIDER: 'cloudflare', RESEND_API_KEY: 'k',
      EMAIL: fakeBinding('down', { message: 'x', code: 'E_RECIPIENT_NOT_ALLOWED' }).binding,
    }
    await senderFor(e as never, db).send({ purpose: 'notification', ...msg('a@b.com') })
    const rows = await db.select().from(emailSendStats).all()
    const by = Object.fromEntries(rows.map(r => [r.provider, r]))
    expect(by.cloudflare).toMatchObject({ sent: 0, failed: 1, suppressed: 0 })
    expect(by.cloudflare.lastError).toContain('E_RECIPIENT_NOT_ALLOWED')
    expect(by.resend).toMatchObject({ sent: 1, failed: 0 })
  })

  it('a send without a db writes nothing and still sends', async () => {
    const cf = fakeBinding('ok')
    const e = { EMAIL_PROVIDER: 'cloudflare', EMAIL: cf.binding }
    const r = await senderFor(e as never).send({ purpose: 'notification', ...msg('a@b.com') })
    expect(r.ok).toBe(true)
    expect(cf.sent).toHaveLength(1)
    expect(await getDb(env.DB).select().from(emailSendStats).all()).toHaveLength(0)
  })

  it('a bulk batch writes one aggregated row for the whole run, with no fallback to the second provider', async () => {
    const db = getDb(env.DB)
    const resend = stubResend()
    // Call n: multiples of 3 are suppressed, multiples of 5 that are not of 3 fail, the rest are delivered.
    const cf = fakeBinding((_m, n) => (n % 3 === 0 ? 'suppressed' : n % 5 === 0 ? 'down' : 'ok'))
    const e = { EMAIL_PROVIDER: 'cloudflare', RESEND_API_KEY: 'k', DEMO_MODE: 'false', EMAIL: cf.binding }
    const messages = Array.from({ length: 20 }, (_, i) => ({ purpose: 'bulk' as const, to: [`u${i}@b.com`], subject: 'Hi', html: '<p>x</p>' }))
    const r = await senderFor(e as never, db).sendBatch(messages)
    const rows = await db.select().from(emailSendStats).all()
    expect(rows).toHaveLength(1)
    // n = 1..20: multiples of 3 are suppressed (6), multiples of 5 not of 3 fail (5, 10, 20)
    expect(rows[0]).toMatchObject({ provider: 'cloudflare', sent: 11, suppressed: 6, failed: 3 })
    expect(resend.calls).toHaveLength(0)
    // A suppressed recipient is not a sent one.
    expect(r).toMatchObject({ sent: 11, failed: 9, skipped: 0 })
  })

  it('a bulk batch counts nothing in demo mode and calls no provider', async () => {
    const db = getDb(env.DB)
    const cf = fakeBinding('ok')
    const e = { EMAIL_PROVIDER: 'cloudflare', DEMO_MODE: 'true', EMAIL: cf.binding }
    const r = await senderFor(e as never, db).sendBatch([{ purpose: 'bulk', to: ['a@b.com'], subject: 'Hi', html: '<p>x</p>' }])
    expect(r).toMatchObject({ sent: 0, failed: 0, skipped: 1 })
    expect(cf.sent).toHaveLength(0)
    expect(await db.select().from(emailSendStats).all()).toHaveLength(0)
  })
})
