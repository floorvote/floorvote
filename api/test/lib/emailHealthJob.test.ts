import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { env } from 'cloudflare:test'
import { clearDb } from '../helpers'
import { getDb } from '../../src/db/client'
import { emailAlertState, emailSendStats } from '../../src/db/schema'
import { recordSendStats } from '../../src/lib/emailStats'
import { runEmailHealth, renderHealthAlert } from '../../src/lib/emailHealthJob'
import { fakeBinding, stubResend, type BindingOutcomes } from '../../../shared/emailTestKit'

const NOW = new Date('2026-09-23T21:00:00Z')
const LAST_HOUR = new Date('2026-09-23T20:30:00Z')
const ERR = 'E_RECIPIENT_NOT_ALLOWED: destination address is not a verified address'

function jobEnv(overrides: Record<string, unknown> = {}, binding: BindingOutcomes = 'ok') {
  const cf = fakeBinding(binding)
  const e = {
    ...env, EMAIL_PROVIDER: 'cloudflare', RESEND_API_KEY: 'k',
    EMAIL: cf.binding, ALERT_EMAILS: 'ops@example.test',
    APP_URL: 'https://ut.example.test', EMAIL_FROM: 'notifications@example.test',
    ...overrides,
  }
  return { e: e as never, cf }
}

describe('runEmailHealth', () => {
  let resend: ReturnType<typeof stubResend>
  beforeEach(async () => {
    await clearDb()
    resend = stubResend()
  })
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

  it('does nothing when healthy', async () => {
    const db = getDb(env.DB)
    await recordSendStats(db, 'cloudflare', { sent: 5, failed: 0, suppressed: 0, lastError: null }, LAST_HOUR)
    const { e } = jobEnv()
    expect(await runEmailHealth(e, db, NOW)).toBe('none')
    expect(resend.calls).toHaveLength(0)
    expect(await db.select().from(emailAlertState).all()).toHaveLength(0)
  })

  it('on trip, alerts through resend (not the failing cloudflare) and records failing state', async () => {
    const db = getDb(env.DB)
    await recordSendStats(db, 'cloudflare', { sent: 0, failed: 3, suppressed: 0, lastError: ERR }, LAST_HOUR)
    const { e, cf } = jobEnv()
    expect(await runEmailHealth(e, db, NOW)).toBe('trip')
    expect(cf.sent).toHaveLength(0)
    expect(resend.calls).toHaveLength(1)
    const body = resend.calls[0].body
    expect(body.to).toEqual(['ops@example.test'])
    expect(body.subject).toContain('ut.example.test')
    expect(body.subject).toContain('cloudflare')
    expect(body.text).toContain(ERR)
    expect(body.text).toContain('Digests and week-ahead mail never fall back')
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
    const { e, cf } = jobEnv({ RESEND_API_KEY: undefined })
    expect(await runEmailHealth(e, db, NOW)).toBe('trip')
    expect(cf.sent).toHaveLength(1)
    expect(resend.calls).toHaveLength(0)
    expect(err.mock.calls.some(c => String(c[0]).includes('no independent alert path'))).toBe(true)
  })

  // The real sender rejects a whole message over one malformed address, so
  // before #781 one typo in ALERT_EMAILS swallowed the outage alert.
  it('alerts the valid address, through resend, when ALERT_EMAILS also holds a malformed entry', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const db = getDb(env.DB)
    await recordSendStats(db, 'cloudflare', { sent: 0, failed: 3, suppressed: 0, lastError: ERR }, LAST_HOUR)
    const { e, cf } = jobEnv({ ALERT_EMAILS: 'ops@example.test, not-an-address' })
    expect(await runEmailHealth(e, db, NOW)).toBe('trip')
    expect(cf.sent).toHaveLength(0)
    expect(resend.calls).toHaveLength(1)
    expect(resend.calls[0].body.to).toEqual(['ops@example.test'])
    expect(err.mock.calls.some(c => String(c[0]).includes('not-an-address'))).toBe(true)
    const [state] = await db.select().from(emailAlertState).all()
    expect(state).toMatchObject({ status: 'failing', lastAlertedAt: '2026-09-23 21:00:00' })
  })

  it('sends nothing, calls no provider, and logs the entries when every ALERT_EMAILS entry is malformed', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const db = getDb(env.DB)
    await recordSendStats(db, 'cloudflare', { sent: 0, failed: 3, suppressed: 0, lastError: ERR }, LAST_HOUR)
    const { e, cf } = jobEnv({ ALERT_EMAILS: 'oops, also@oops' })
    expect(await runEmailHealth(e, db, NOW)).toBe('trip')
    expect(cf.sent).toHaveLength(0)
    expect(resend.calls).toHaveLength(0)
    const logged = err.mock.calls.map(c => c.map(String).join(' ')).join('\n')
    expect(logged).toContain('also@oops')
    expect(logged).toContain('no alert sent')
    const [state] = await db.select().from(emailAlertState).all()
    expect(state).toMatchObject({ status: 'failing', lastAlertedAt: null })
  })

  it('records state even when ALERT_EMAILS is unset, and sends nothing', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const db = getDb(env.DB)
    await recordSendStats(db, 'cloudflare', { sent: 0, failed: 3, suppressed: 0, lastError: ERR }, LAST_HOUR)
    const { e } = jobEnv({ ALERT_EMAILS: '' })
    expect(await runEmailHealth(e, db, NOW)).toBe('trip')
    expect(resend.calls).toHaveLength(0)
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
    const body = resend.calls[0].body
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
    const body = resend.calls[0].body
    expect(body.text).toContain('3 sent through resend')
  })

  it('does not count its own alert in email_send_stats', async () => {
    const db = getDb(env.DB)
    await recordSendStats(db, 'cloudflare', { sent: 0, failed: 3, suppressed: 0, lastError: ERR }, LAST_HOUR)
    const { e } = jobEnv()
    await runEmailHealth(e, db, NOW)
    expect(resend.calls).toHaveLength(1)
    const rows = await db.select().from(emailSendStats).all()
    expect(rows.filter(r => r.provider === 'resend')).toHaveLength(0)
    expect(rows.filter(r => r.provider === 'cloudflare')).toHaveLength(1)
  })

  it('rescues a rejected alternate by sending the alert through the primary', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    resend = stubResend('down', { status: 401, body: 'unauthorized' })
    const db = getDb(env.DB)
    await recordSendStats(db, 'cloudflare', { sent: 0, failed: 3, suppressed: 0, lastError: ERR }, LAST_HOUR)
    const { e, cf } = jobEnv()
    expect(await runEmailHealth(e, db, NOW)).toBe('trip')
    expect(resend.calls).toHaveLength(1)
    expect(cf.sent).toHaveLength(1)
    const [state] = await db.select().from(emailAlertState).all()
    expect(state).toMatchObject({ status: 'failing', lastAlertedAt: '2026-09-23 21:00:00' })
  })

  it('when both providers fail, leaves lastAlertedAt null and retries with trip wording next hour', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    resend = stubResend('down', { status: 401, body: 'unauthorized' })
    const db = getDb(env.DB)
    await recordSendStats(db, 'cloudflare', { sent: 0, failed: 3, suppressed: 0, lastError: ERR }, LAST_HOUR)
    const { e, cf } = jobEnv({}, 'down')
    expect(await runEmailHealth(e, db, NOW)).toBe('trip')
    const [after1] = await db.select().from(emailAlertState).all()
    expect(after1).toMatchObject({ status: 'failing', lastAlertedAt: null })

    resend.calls.length = 0; cf.sent.length = 0
    expect(await runEmailHealth(e, db, new Date(NOW.getTime() + 60 * 60 * 1000))).toBe('remind')
    expect(resend.calls).toHaveLength(1)
    expect(cf.sent).toHaveLength(1)
    const sent = cf.sent[0]
    expect(sent.subject).toContain('is failing')
    expect(sent.subject).not.toContain('still failing')
  })

  it('alerts through cloudflare, not the failing resend, when resend is the primary', async () => {
    const db = getDb(env.DB)
    await recordSendStats(db, 'resend', { sent: 0, failed: 3, suppressed: 0, lastError: '500' }, LAST_HOUR)
    const { e, cf } = jobEnv({ EMAIL_PROVIDER: 'resend' })
    expect(await runEmailHealth(e, db, NOW)).toBe('trip')
    expect(cf.sent).toHaveLength(1)
    expect(resend.calls).toHaveLength(0)
    const sent = cf.sent[0]
    expect(sent.to).toEqual(['ops@example.test'])
    expect(sent.subject).toContain('resend')
  })

  it('sends the alert in demo mode', async () => {
    const db = getDb(env.DB)
    await recordSendStats(db, 'cloudflare', { sent: 0, failed: 3, suppressed: 0, lastError: ERR }, LAST_HOUR)
    const { e } = jobEnv({ DEMO_MODE: 'true' })
    expect(await runEmailHealth(e, db, NOW)).toBe('trip')
    expect(resend.calls).toHaveLength(1)
    const [state] = await db.select().from(emailAlertState).all()
    expect(state).toMatchObject({ status: 'failing', lastAlertedAt: '2026-09-23 21:00:00' })
  })

  it('does not count an alert that needed both providers either', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    resend = stubResend('down', { status: 401, body: 'unauthorized' })
    const db = getDb(env.DB)
    await recordSendStats(db, 'cloudflare', { sent: 0, failed: 3, suppressed: 0, lastError: ERR }, LAST_HOUR)
    const { e, cf } = jobEnv()
    await runEmailHealth(e, db, NOW)
    expect(resend.calls).toHaveLength(1)
    expect(cf.sent).toHaveLength(1)
    const rows = await db.select().from(emailSendStats).all()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ provider: 'cloudflare', sent: 0, failed: 3 })
  })

  it('writes no Resend usage reading for its own alert', async () => {
    resend = stubResend('ok', { headers: { 'x-resend-monthly-quota': '900', 'x-resend-daily-quota': '50' } })
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
    const body = resend.calls[0].body
    expect(body.subject).toContain('still failing')
    expect(body.text).toContain('since 2026-09-22 10:00:00 UTC')
  })
})

// The alert says which emails fall back. This is the one place an operator
// reads it during an outage, so the wording is pinned: sign-in, account,
// notification, and operator email falls back, and digests and week-ahead mail
// never do. (The docs and AGENTS.md say the same thing; a rule change has to
// change all three.)
describe('the alert\'s wording on which emails fall back', () => {
  const rows = [{ hour: '2026-09-23 20:00:00', sent: 0, failed: 3, suppressed: 0, lastError: 'E_INTERNAL_SERVER_ERROR: down' }]
  const input = (over: Record<string, unknown> = {}) => ({
    decision: 'trip' as const, primary: 'cloudflare' as const, alternate: 'resend' as const,
    rows, rescued: 3, failingSince: '2026-09-23 21:00:00', ...over,
  })
  const render = (over: Record<string, unknown> = {}) => renderHealthAlert({ APP_URL: 'https://ut.example.test' }, input(over) as never)
  const lines = (over: Record<string, unknown> = {}) => render(over).text.split('\n')

  it('says exactly which emails fall back to the other provider, and how many it carried', () => {
    expect(lines()).toContain('Sign-in, account, notification, and operator email fall back to resend: 3 sent through resend in the last 24 hours.')
  })

  it('says digests and week-ahead mail never fall back, so they are not being delivered', () => {
    expect(lines()).toContain('Digests and week-ahead mail never fall back, so they are not being delivered.')
  })

  it('says the same on a reminder, whichever provider is failing', () => {
    const l = lines({ decision: 'remind', primary: 'resend', alternate: 'cloudflare', rescued: 0 })
    expect(l).toContain('Sign-in, account, notification, and operator email fall back to cloudflare: 0 sent through cloudflare in the last 24 hours.')
    expect(l).toContain('Digests and week-ahead mail never fall back, so they are not being delivered.')
  })

  it('names the same four kinds of email as failing, with nothing to fall back to', () => {
    const l = lines({ alternate: null, rescued: null })
    expect(l).toContain('No fallback provider is configured, so sign-in, account, notification, and operator email are failing too.')
    expect(l).toContain('Digests and week-ahead mail never fall back, so they are not being delivered.')
    expect(l.join('\n')).not.toContain('fall back to')
  })

  it('has neither line on a recovery notice', () => {
    const text = render({ decision: 'recover' }).text
    expect(text).not.toMatch(/fall back/)
    expect(text).not.toContain('not being delivered')
  })

  it('no longer says login and invite links are the only mail that falls back', () => {
    const { text, html } = render()
    expect(text).not.toContain('Login and invite links')
    expect(html).not.toContain('Login and invite links')
    expect(text).not.toContain('do not fall back')
  })

  it('carries the same wording in the html part', () => {
    const { html } = render()
    expect(html).toContain('Sign-in, account, notification, and operator email fall back to resend')
    expect(html).toContain('Digests and week-ahead mail never fall back')
  })
})
