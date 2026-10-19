import { describe, it, expect, beforeEach, vi } from 'vitest'
import { env } from 'cloudflare:test'
import { clearDb } from '../helpers'
import { getDb } from '../../src/db/client'
import { emailSendStats } from '../../src/db/schema'
import { hourKey, tally, recordSendStats } from '../../src/lib/emailStats'

const T = new Date('2026-09-23T20:17:42Z')

describe('hourKey', () => {
  it('truncates to the UTC hour in DB format', () => {
    expect(hourKey(T)).toBe('2026-09-23 20:00:00')
  })
})

describe('tally', () => {
  it('splits attempts into sent, failed, and suppressed, keeping the last provider error', () => {
    expect(tally([
      { ok: true, provider: 'cloudflare' },
      { ok: false, provider: 'cloudflare', error: 'E_RECIPIENT_NOT_ALLOWED: a', permanent: false },
      { ok: false, provider: 'cloudflare', error: 'E_RECIPIENT_SUPPRESSED: b', permanent: true },
      { ok: false, provider: 'cloudflare', error: 'E_RATE_LIMIT_EXCEEDED: c', permanent: false },
    ])).toEqual({ sent: 1, failed: 2, suppressed: 1, lastError: 'E_RATE_LIMIT_EXCEEDED: c' })
  })

  it('trusts the adapter\'s verdict, not the error text: a permanent failure is suppressed whatever it says', () => {
    expect(tally([{ ok: false, provider: 'resend', error: '550 mailbox full', permanent: true }]))
      .toEqual({ sent: 0, failed: 0, suppressed: 1, lastError: null })
  })

  it('counts an error mentioning a suppressed recipient as failed when the adapter called it temporary', () => {
    expect(tally([{ ok: false, provider: 'cloudflare', error: 'E_RECIPIENT_SUPPRESSED: b', permanent: false }]))
      .toEqual({ sent: 0, failed: 1, suppressed: 0, lastError: 'E_RECIPIENT_SUPPRESSED: b' })
  })
})

describe('recordSendStats', () => {
  beforeEach(async () => { await clearDb() })

  it('upserts into one row per hour and provider, incrementing counts', async () => {
    const db = getDb(env.DB)
    await recordSendStats(db, 'cloudflare', { sent: 1, failed: 0, suppressed: 0, lastError: null }, T)
    await recordSendStats(db, 'cloudflare', { sent: 0, failed: 2, suppressed: 1, lastError: 'E_RECIPIENT_NOT_ALLOWED: x' }, new Date('2026-09-23T20:40:00Z'))
    const rows = await db.select().from(emailSendStats).all()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      hour: '2026-09-23 20:00:00', provider: 'cloudflare',
      sent: 1, failed: 2, suppressed: 1,
      lastError: 'E_RECIPIENT_NOT_ALLOWED: x',
      lastSentAt: '2026-09-23 20:17:42',
      lastFailedAt: '2026-09-23 20:40:00',
    })
  })

  it('keeps separate rows per provider and per hour', async () => {
    const db = getDb(env.DB)
    await recordSendStats(db, 'cloudflare', { sent: 1, failed: 0, suppressed: 0, lastError: null }, T)
    await recordSendStats(db, 'resend', { sent: 1, failed: 0, suppressed: 0, lastError: null }, T)
    await recordSendStats(db, 'cloudflare', { sent: 1, failed: 0, suppressed: 0, lastError: null }, new Date('2026-09-23T21:05:00Z'))
    expect(await db.select().from(emailSendStats).all()).toHaveLength(3)
  })

  it('does not overwrite last_error with null on a later success', async () => {
    const db = getDb(env.DB)
    await recordSendStats(db, 'cloudflare', { sent: 0, failed: 1, suppressed: 0, lastError: 'boom' }, T)
    await recordSendStats(db, 'cloudflare', { sent: 1, failed: 0, suppressed: 0, lastError: null }, T)
    const [row] = await db.select().from(emailSendStats).all()
    expect(row.lastError).toBe('boom')
  })

  it('writes nothing for an empty tally', async () => {
    const db = getDb(env.DB)
    await recordSendStats(db, 'cloudflare', { sent: 0, failed: 0, suppressed: 0, lastError: null }, T)
    expect(await db.select().from(emailSendStats).all()).toHaveLength(0)
  })

  it('never throws when the write fails', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const broken = { insert: () => { throw new Error('D1 down') } } as never
    await expect(recordSendStats(broken, 'cloudflare', { sent: 1, failed: 0, suppressed: 0, lastError: null }, T)).resolves.toBeUndefined()
    expect(err).toHaveBeenCalled()
    err.mockRestore()
  })
})
