import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { env } from 'cloudflare:test'
import { clearDb } from '../helpers'
import { getDb } from '../../src/db/client'
import { recordSendStats } from '../../src/lib/emailStats'

// The outage alert names its purpose and leaves the provider order to the
// sender (#709): the caller no longer picks the healthy provider, sets
// fallback, or passes a db. The order itself is tested at the sender
// (shared/emailSender.test.ts) and end to end in emailHealthJob.test.ts.
vi.mock('../../src/lib/email', async (importOriginal) =>
  (await import('../mail')).withFakeSender(await importOriginal<typeof import('../../src/lib/email')>()))

import { runEmailHealth } from '../../src/lib/emailHealthJob'
import { mail, senderFor, resetMail } from '../mail'
import { fakeBinding } from '../../../shared/emailTestKit'

const NOW = new Date('2026-09-23T21:00:00Z')
const LAST_HOUR = new Date('2026-09-23T20:30:00Z')
const ERR = 'E_INTERNAL_SERVER_ERROR: down'
const jobEnv = (over: Record<string, unknown> = {}) => ({
  ...env, EMAIL_PROVIDER: 'cloudflare', RESEND_API_KEY: 'test-api-key', EMAIL: fakeBinding().binding,
  ALERT_EMAILS: 'ops@example.test, ops2@example.test', APP_URL: 'https://ut.example.test',
  ...over,
}) as never

beforeEach(async () => {
  await clearDb()
  resetMail()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

async function trip() {
  const db = getDb(env.DB)
  await recordSendStats(db, 'cloudflare', { sent: 0, failed: 3, suppressed: 0, lastError: ERR }, LAST_HOUR)
  return db
}

describe('the outage alert', () => {
  it('is sent with the outage-alert purpose, to every alert address, and with no db', async () => {
    const db = await trip()
    expect(await runEmailHealth(jobEnv(), db, NOW)).toBe('trip')
    expect(senderFor).toHaveBeenCalledOnce()
    expect(senderFor.mock.calls[0][1]).toBeUndefined()
    expect(mail.send).toHaveBeenCalledOnce()
    expect(mail.send.mock.calls[0][0]).toMatchObject({ purpose: 'outage-alert', to: ['ops@example.test', 'ops2@example.test'] })
    expect(mail.send.mock.calls[0][0].subject).toContain('cloudflare')
  })

  it('carries only its purpose and content, so no caller-side order, fallback, or provider choice', async () => {
    const db = await trip()
    await runEmailHealth(jobEnv(), db, NOW)
    expect(mail.send).toHaveBeenCalledOnce()
    expect(Object.keys(mail.send.mock.calls[0][0]).sort()).toEqual(['html', 'purpose', 'subject', 'text', 'to'])
  })

  it('is sent the same way when there is no other provider', async () => {
    const db = await trip()
    await runEmailHealth(jobEnv({ RESEND_API_KEY: undefined }), db, NOW)
    expect(mail.send).toHaveBeenCalledOnce()
    expect(mail.send.mock.calls[0][0]).toMatchObject({ purpose: 'outage-alert' })
  })

  it('records the state as not alerted when the sender reports a failure, and does not throw', async () => {
    mail.send.mockResolvedValue({ ok: false, provider: 'cloudflare', error: 'down', permanent: false, attempts: [] } as never)
    const db = await trip()
    expect(await runEmailHealth(jobEnv(), db, NOW)).toBe('trip')
    const { emailAlertState } = await import('../../src/db/schema')
    const [state] = await db.select().from(emailAlertState).all()
    expect(state).toMatchObject({ status: 'failing', lastAlertedAt: null })
  })

  it('does not throw when the sender throws', async () => {
    mail.send.mockRejectedValue(new Error('boom'))
    const db = await trip()
    await expect(runEmailHealth(jobEnv(), db, NOW)).resolves.toBe('trip')
    expect(mail.send).toHaveBeenCalledOnce()
  })
})

// A malformed ALERT_EMAILS entry must not block the outage alert to the good
// addresses (#781): the alert goes to the valid ones, the dropped ones are
// logged, and with none left it is not sent and the state records that no
// alert went out (so the next hourly run tries again), as for an unset var.
describe('the outage alert: a malformed ALERT_EMAILS entry', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>
  beforeEach(() => { errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {}) })
  const logged = () => errorSpy.mock.calls.map(c => c.map(String).join(' ')).join('\n')
  const stateOf = async (db: Awaited<ReturnType<typeof trip>>) => {
    const { emailAlertState } = await import('../../src/db/schema')
    return (await db.select().from(emailAlertState).all())[0]
  }

  it('is sent to the valid address, and the invalid entry is logged', async () => {
    const db = await trip()
    expect(await runEmailHealth(jobEnv({ ALERT_EMAILS: 'ops@example.test, not-an-address' }), db, NOW)).toBe('trip')
    expect(mail.send).toHaveBeenCalledOnce()
    expect(mail.send.mock.calls[0][0]).toMatchObject({ purpose: 'outage-alert', to: ['ops@example.test'] })
    expect(logged()).toContain('not-an-address')
    expect(logged()).toContain('ALERT_EMAILS')
    expect(await stateOf(db)).toMatchObject({ status: 'failing', lastAlertedAt: '2026-09-23 21:00:00' })
  })

  it('is not sent, and the state records no alert, when every entry is invalid', async () => {
    const db = await trip()
    expect(await runEmailHealth(jobEnv({ ALERT_EMAILS: 'oops, also@oops' }), db, NOW)).toBe('trip')
    expect(mail.send).not.toHaveBeenCalled()
    expect(logged()).toContain('also@oops')
    expect(logged()).toContain('no alert sent')
    expect(await stateOf(db)).toMatchObject({ status: 'failing', lastAlertedAt: null })
  })

  it('is sent to every address, with nothing logged about addresses, when all are valid', async () => {
    const db = await trip()
    await runEmailHealth(jobEnv({ ALERT_EMAILS: 'a@example.test, b@example.test' }), db, NOW)
    expect(mail.send.mock.calls[0][0].to).toEqual(['a@example.test', 'b@example.test'])
    expect(logged()).not.toContain('ALERT_EMAILS')
  })

  it('ignores blank entries, trims, and sends to a duplicated address once', async () => {
    const db = await trip()
    await runEmailHealth(jobEnv({ ALERT_EMAILS: ' a@example.test ,, Ops@example.test , ops@example.test,' }), db, NOW)
    expect(mail.send.mock.calls[0][0].to).toEqual(['a@example.test', 'Ops@example.test'])
  })

  it('drops the display-name form, and sends to the bare address beside it', async () => {
    const db = await trip()
    await runEmailHealth(jobEnv({ ALERT_EMAILS: 'Ops <ops@example.test>, b@example.test' }), db, NOW)
    expect(mail.send.mock.calls[0][0].to).toEqual(['b@example.test'])
    expect(logged()).toContain('Ops <ops@example.test>')
  })

  it('keeps an upper-case address as written', async () => {
    const db = await trip()
    await runEmailHealth(jobEnv({ ALERT_EMAILS: 'OPS@EXAMPLE.TEST, oops' }), db, NOW)
    expect(mail.send.mock.calls[0][0].to).toEqual(['OPS@EXAMPLE.TEST'])
  })

  it('sends the recovery notice to the valid addresses too', async () => {
    const { emailAlertState } = await import('../../src/db/schema')
    const db = getDb(env.DB)
    await db.insert(emailAlertState).values({
      provider: 'cloudflare', status: 'failing', failingSince: '2026-09-22 10:00:00', lastAlertedAt: '2026-09-23 12:00:00',
    })
    await recordSendStats(db, 'cloudflare', { sent: 4, failed: 0, suppressed: 0, lastError: null }, LAST_HOUR)
    expect(await runEmailHealth(jobEnv({ ALERT_EMAILS: 'oops, ops@example.test' }), db, NOW)).toBe('recover')
    expect(mail.send.mock.calls[0][0]).toMatchObject({ to: ['ops@example.test'] })
  })
})

