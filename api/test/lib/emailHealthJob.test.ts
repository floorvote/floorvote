import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { env } from 'cloudflare:test'
import { resetDb, applyMigrations } from '../helpers'
import { getDb } from '../../src/db/client'
import { emailAlertState, emailSendStats } from '../../src/db/schema'
import { recordSendStats } from '../../src/lib/emailStats'
import { runEmailHealth } from '../../src/lib/emailHealthJob'

const NOW = new Date('2026-09-23T21:00:00Z')
const LAST_HOUR = new Date('2026-09-23T20:30:00Z')
const ERR = 'E_RECIPIENT_NOT_ALLOWED: destination address is not a verified address'

function jobEnv(overrides: Record<string, unknown> = {}) {
  const cfSend = vi.fn(async () => ({ messageId: 'cf-alert' }))
  const e = {
    ...env, EMAIL_PROVIDER: 'cloudflare', RESEND_API_KEY: 'k',
    EMAIL: { send: cfSend }, ALERT_EMAILS: 'ops@example.test',
    APP_URL: 'https://ut.example.test', EMAIL_FROM: 'notifications@example.test',
    ...overrides,
  }
  return { e: e as never, cfSend }
}

describe('runEmailHealth', () => {
  let fetch: ReturnType<typeof vi.fn>
  beforeEach(async () => {
    await resetDb(); await applyMigrations()
    fetch = vi.fn(async () => new Response(JSON.stringify({ id: 'rs-alert' }), { status: 200 }))
    vi.stubGlobal('fetch', fetch)
  })
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

  it('does nothing when healthy', async () => {
    const db = getDb(env.DB)
    await recordSendStats(db, 'cloudflare', { sent: 5, failed: 0, suppressed: 0, lastError: null }, LAST_HOUR)
    const { e } = jobEnv()
    expect(await runEmailHealth(e, db, NOW)).toBe('none')
    expect(fetch).not.toHaveBeenCalled()
    expect(await db.select().from(emailAlertState).all()).toHaveLength(0)
  })

  it('on trip, alerts through resend (not the failing cloudflare) and records failing state', async () => {
    const db = getDb(env.DB)
    await recordSendStats(db, 'cloudflare', { sent: 0, failed: 3, suppressed: 0, lastError: ERR }, LAST_HOUR)
    const { e, cfSend } = jobEnv()
    expect(await runEmailHealth(e, db, NOW)).toBe('trip')
    expect(cfSend).not.toHaveBeenCalled()
    expect(fetch).toHaveBeenCalledOnce()
    const body = JSON.parse((fetch.mock.calls[0][1] as RequestInit).body as string)
    expect(body.to).toEqual(['ops@example.test'])
    expect(body.subject).toContain('ut.example.test')
    expect(body.subject).toContain('cloudflare')
    expect(body.text).toContain(ERR)
    expect(body.text).toMatch(/Digests and week-ahead mail do not fall back/)
    const [state] = await db.select().from(emailAlertState).all()
    expect(state).toMatchObject({
      provider: 'cloudflare', status: 'failing',
      failingSince: '2026-09-23 21:00:00', lastAlertedAt: '2026-09-23 21:00:00',
    })
  })

  it('with no other provider, alerts through the primary and logs that there is no independent path', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const db = getDb(env.DB)
    await recordSendStats(db, 'cloudflare', { sent: 0, failed: 3, suppressed: 0, lastError: ERR }, LAST_HOUR)
    const { e, cfSend } = jobEnv({ RESEND_API_KEY: undefined })
    expect(await runEmailHealth(e, db, NOW)).toBe('trip')
    expect(cfSend).toHaveBeenCalledOnce()
    expect(fetch).not.toHaveBeenCalled()
    expect(err.mock.calls.some(c => String(c[0]).includes('no independent alert path'))).toBe(true)
  })

  it('records state even when ALERT_EMAILS is unset, and sends nothing', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const db = getDb(env.DB)
    await recordSendStats(db, 'cloudflare', { sent: 0, failed: 3, suppressed: 0, lastError: ERR }, LAST_HOUR)
    const { e } = jobEnv({ ALERT_EMAILS: '' })
    expect(await runEmailHealth(e, db, NOW)).toBe('trip')
    expect(fetch).not.toHaveBeenCalled()
    const [state] = await db.select().from(emailAlertState).all()
    expect(state).toMatchObject({ status: 'failing', lastAlertedAt: null })
  })

  it('on recover, sends a recovery notice and returns to ok', async () => {
    const db = getDb(env.DB)
    await db.insert(emailAlertState).values({
      provider: 'cloudflare', status: 'failing', failingSince: '2026-09-22 10:00:00', lastAlertedAt: '2026-09-23 12:00:00',
    })
    await recordSendStats(db, 'cloudflare', { sent: 4, failed: 0, suppressed: 0, lastError: null }, LAST_HOUR)
    const { e } = jobEnv()
    expect(await runEmailHealth(e, db, NOW)).toBe('recover')
    const body = JSON.parse((fetch.mock.calls[0][1] as RequestInit).body as string)
    expect(body.subject).toMatch(/recovered/i)
    const [state] = await db.select().from(emailAlertState).all()
    expect(state).toMatchObject({ status: 'ok', failingSince: null, recoveredAt: '2026-09-23 21:00:00' })
  })

  it("reports the other provider's sends in the window as the rescue count", async () => {
    const db = getDb(env.DB)
    await recordSendStats(db, 'cloudflare', { sent: 0, failed: 3, suppressed: 0, lastError: ERR }, LAST_HOUR)
    await recordSendStats(db, 'resend', { sent: 3, failed: 0, suppressed: 0, lastError: null }, LAST_HOUR)
    const { e } = jobEnv()
    await runEmailHealth(e, db, NOW)
    const body = JSON.parse((fetch.mock.calls[0][1] as RequestInit).body as string)
    expect(body.text).toContain('3 sent through resend')
  })

  it('does not count its own alert in email_send_stats', async () => {
    const db = getDb(env.DB)
    await recordSendStats(db, 'cloudflare', { sent: 0, failed: 3, suppressed: 0, lastError: ERR }, LAST_HOUR)
    const { e } = jobEnv()
    await runEmailHealth(e, db, NOW)
    expect(fetch).toHaveBeenCalledOnce()
    const rows = await db.select().from(emailSendStats).all()
    expect(rows.filter(r => r.provider === 'resend')).toHaveLength(0)
    expect(rows.filter(r => r.provider === 'cloudflare')).toHaveLength(1)
  })

  it('rescues a rejected alternate by sending the alert through the primary', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    fetch.mockImplementation(async () => new Response('unauthorized', { status: 401 }))
    const db = getDb(env.DB)
    await recordSendStats(db, 'cloudflare', { sent: 0, failed: 3, suppressed: 0, lastError: ERR }, LAST_HOUR)
    const { e, cfSend } = jobEnv()
    expect(await runEmailHealth(e, db, NOW)).toBe('trip')
    expect(fetch).toHaveBeenCalledOnce()
    expect(cfSend).toHaveBeenCalledOnce()
    const [state] = await db.select().from(emailAlertState).all()
    expect(state).toMatchObject({ status: 'failing', lastAlertedAt: '2026-09-23 21:00:00' })
  })

  it('when both providers fail, leaves lastAlertedAt null and retries with trip wording next hour', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    fetch.mockImplementation(async () => new Response('unauthorized', { status: 401 }))
    const db = getDb(env.DB)
    await recordSendStats(db, 'cloudflare', { sent: 0, failed: 3, suppressed: 0, lastError: ERR }, LAST_HOUR)
    const { e, cfSend } = jobEnv()
    cfSend.mockImplementation(async () => { throw new Error('cf down') })
    expect(await runEmailHealth(e, db, NOW)).toBe('trip')
    const [after1] = await db.select().from(emailAlertState).all()
    expect(after1).toMatchObject({ status: 'failing', lastAlertedAt: null })

    fetch.mockClear(); cfSend.mockClear()
    expect(await runEmailHealth(e, db, new Date(NOW.getTime() + 60 * 60 * 1000))).toBe('remind')
    expect(fetch).toHaveBeenCalledOnce()
    expect(cfSend).toHaveBeenCalledOnce()
    const sent = cfSend.mock.calls[0][0] as { subject: string }
    expect(sent.subject).toContain('is failing')
    expect(sent.subject).not.toContain('still failing')
  })

  it('alerts through cloudflare, not the failing resend, when resend is the primary', async () => {
    const db = getDb(env.DB)
    await recordSendStats(db, 'resend', { sent: 0, failed: 3, suppressed: 0, lastError: '500' }, LAST_HOUR)
    const { e, cfSend } = jobEnv({ EMAIL_PROVIDER: 'resend' })
    expect(await runEmailHealth(e, db, NOW)).toBe('trip')
    expect(cfSend).toHaveBeenCalledOnce()
    expect(fetch).not.toHaveBeenCalled()
    const sent = cfSend.mock.calls[0][0] as { to: string[]; subject: string }
    expect(sent.to).toEqual(['ops@example.test'])
    expect(sent.subject).toContain('resend')
  })

  it('sends the alert in demo mode', async () => {
    const db = getDb(env.DB)
    await recordSendStats(db, 'cloudflare', { sent: 0, failed: 3, suppressed: 0, lastError: ERR }, LAST_HOUR)
    const { e } = jobEnv({ DEMO_MODE: 'true' })
    expect(await runEmailHealth(e, db, NOW)).toBe('trip')
    expect(fetch).toHaveBeenCalledOnce()
    const [state] = await db.select().from(emailAlertState).all()
    expect(state).toMatchObject({ status: 'failing', lastAlertedAt: '2026-09-23 21:00:00' })
  })

  it('does not count an alert that needed both providers either', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    fetch.mockImplementation(async () => new Response('unauthorized', { status: 401 }))
    const db = getDb(env.DB)
    await recordSendStats(db, 'cloudflare', { sent: 0, failed: 3, suppressed: 0, lastError: ERR }, LAST_HOUR)
    const { e, cfSend } = jobEnv()
    await runEmailHealth(e, db, NOW)
    expect(fetch).toHaveBeenCalledOnce()
    expect(cfSend).toHaveBeenCalledOnce()
    const rows = await db.select().from(emailSendStats).all()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ provider: 'cloudflare', sent: 0, failed: 3 })
  })

  it('writes no Resend usage reading for its own alert', async () => {
    fetch.mockImplementation(async () => new Response(JSON.stringify({ id: 'rs-alert' }), { status: 200, headers: { 'x-resend-monthly-quota': '900', 'x-resend-daily-quota': '50' } }))
    const db = getDb(env.DB)
    await recordSendStats(db, 'cloudflare', { sent: 0, failed: 3, suppressed: 0, lastError: ERR }, LAST_HOUR)
    const { e } = jobEnv()
    await runEmailHealth(e, db, NOW)
    const { associationConfig } = await import('../../src/db/schema')
    expect((await db.select().from(associationConfig).all()).filter(r => r.key.startsWith('resend_'))).toEqual([])
  })

  it('on remind, says still failing and since when', async () => {
    const db = getDb(env.DB)
    await db.insert(emailAlertState).values({
      provider: 'cloudflare', status: 'failing', failingSince: '2026-09-22 10:00:00', lastAlertedAt: '2026-09-22 20:00:00',
    })
    await recordSendStats(db, 'cloudflare', { sent: 0, failed: 3, suppressed: 0, lastError: ERR }, LAST_HOUR)
    const { e } = jobEnv()
    expect(await runEmailHealth(e, db, NOW)).toBe('remind')
    const body = JSON.parse((fetch.mock.calls[0][1] as RequestInit).body as string)
    expect(body.subject).toContain('still failing')
    expect(body.text).toContain('since 2026-09-22 10:00:00 UTC')
  })
})
