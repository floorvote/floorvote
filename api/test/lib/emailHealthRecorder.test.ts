import { describe, it, expect, beforeEach, vi } from 'vitest'
import { env } from 'cloudflare:test'
import { eq } from 'drizzle-orm'
import { resetDb, applyMigrations } from '../helpers'
import { getDb } from '../../src/db/client'
import { associationConfig, emailSendStats } from '../../src/db/schema'
import { emailHealthRecorder } from '../../src/lib/emailHealthRecorder'

// The API's health recorder: what the shared sender calls with the attempts of
// a counted send. It writes email_send_stats (per provider) and Resend usage.

async function statsByProvider() {
  const rows = await getDb(env.DB).select().from(emailSendStats).all()
  return Object.fromEntries(rows.map(r => [r.provider, r]))
}

async function config(key: string) {
  return (await getDb(env.DB).select().from(associationConfig).where(eq(associationConfig.key, key)).get())?.value
}

describe('emailHealthRecorder', () => {
  beforeEach(async () => { await resetDb(); await applyMigrations() })

  it('counts each attempt to its own provider', async () => {
    await emailHealthRecorder(getDb(env.DB)).record([
      { ok: false, provider: 'cloudflare', error: 'E_INTERNAL_SERVER_ERROR: down', permanent: false },
      { ok: true, provider: 'resend', messageId: 'rs-1' },
    ])
    const by = await statsByProvider()
    expect(by.cloudflare).toMatchObject({ sent: 0, failed: 1, suppressed: 0, lastError: 'E_INTERNAL_SERVER_ERROR: down' })
    expect(by.resend).toMatchObject({ sent: 1, failed: 0, suppressed: 0 })
  })

  it('counts a permanent failure as suppressed, not as a provider failure', async () => {
    await emailHealthRecorder(getDb(env.DB)).record([
      { ok: false, provider: 'cloudflare', error: 'E_RECIPIENT_SUPPRESSED: gone', permanent: true },
    ])
    expect((await statsByProvider()).cloudflare).toMatchObject({ sent: 0, failed: 0, suppressed: 1 })
  })

  it('writes one row per provider for a batch of attempts', async () => {
    await emailHealthRecorder(getDb(env.DB)).record([
      { ok: true, provider: 'cloudflare' }, { ok: true, provider: 'cloudflare' },
      { ok: false, provider: 'cloudflare', error: 'outage', permanent: false },
      { ok: true, provider: 'resend' },
    ])
    const rows = await getDb(env.DB).select().from(emailSendStats).all()
    expect(rows).toHaveLength(2)
    expect((await statsByProvider()).cloudflare).toMatchObject({ sent: 2, failed: 1 })
  })

  it('writes Resend usage read from the attempt', async () => {
    await emailHealthRecorder(getDb(env.DB)).record([
      { ok: true, provider: 'resend', usage: { monthlyUsed: 900, dailyUsed: 12, throttled: false } },
    ])
    expect(await config('resend_monthly_used')).toBe('900')
    expect(await config('resend_daily_used')).toBe('12')
    expect((await config('resend_used_at')) ?? '').toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
    expect(await config('resend_last_429_at')).toBeUndefined()
  })

  it('records a Resend 429', async () => {
    await emailHealthRecorder(getDb(env.DB)).record([
      { ok: false, provider: 'resend', error: '429', permanent: false, usage: { monthlyUsed: null, dailyUsed: null, throttled: true } },
    ])
    expect((await config('resend_last_429_at')) ?? '').toMatch(/^\d{4}-/)
    expect(await config('resend_monthly_used')).toBeUndefined()
  })

  it('writes nothing for no attempts, and the next real attempt is still counted', async () => {
    const recorder = emailHealthRecorder(getDb(env.DB))
    await recorder.record([])
    expect(await getDb(env.DB).select().from(emailSendStats).all()).toHaveLength(0)
    await recorder.record([{ ok: true, provider: 'resend' }])
    expect(await getDb(env.DB).select().from(emailSendStats).all()).toHaveLength(1)
  })

  it('logs, and never throws, when a write fails', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const broken = { insert: () => { throw new Error('db down') } } as never
    await expect(emailHealthRecorder(broken).record([
      { ok: true, provider: 'resend', usage: { monthlyUsed: 1, dailyUsed: 1, throttled: false } },
    ])).resolves.toBeUndefined()
    expect(logged).toHaveBeenCalled()
    vi.restoreAllMocks()
  })
})
