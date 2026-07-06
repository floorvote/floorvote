import { describe, it, expect, beforeEach, vi } from 'vitest'
import { env } from 'cloudflare:test'
import { resetDb, applyMigrations } from '../helpers'
import { getDb } from '../../src/db/client'
import { authEvents } from '../../src/db/schema'
import { sendMagicLink } from '../../src/lib/email'

const baseEnv = (overrides: Record<string, unknown> = {}) => ({
  APP_URL: 'http://localhost', EMAIL_PROVIDER: 'cloudflare', DEMO_MODE: 'false',
  ASSOCIATION_NAME: 'Test', EMAIL_FROM: 'notifications@example.com',
  ...overrides,
}) as never

describe('sendMagicLink records auth events', () => {
  beforeEach(async () => { await resetDb(); await applyMigrations() })

  it('records email_sent (with messageId) on a successful cloudflare send', async () => {
    const db = getDb(env.DB)
    const EMAIL = { send: vi.fn().mockResolvedValue({ messageId: 'cf-123' }) }
    await sendMagicLink('a@b.com', 'http://localhost/auth/verify?token=t', baseEnv({ EMAIL }), 'login', db, 'user-1')
    const [row] = await db.select().from(authEvents).all()
    expect(row.event).toBe('email_sent')
    expect(row.messageId).toBe('cf-123')
    expect(row.userId).toBe('user-1')
    expect(row.provider).toBe('cloudflare')
    expect(row.linkType).toBe('login')
  })

  it('records email_bounced when the recipient is suppressed', async () => {
    const db = getDb(env.DB)
    const EMAIL = { send: vi.fn().mockRejectedValue(Object.assign(new Error('suppressed'), { code: 'E_RECIPIENT_SUPPRESSED' })) }
    await sendMagicLink('a@b.com', 'http://localhost/x', baseEnv({ EMAIL }), 'login', db, 'user-1').catch(() => {})
    const [row] = await db.select().from(authEvents).all()
    expect(row.event).toBe('email_bounced')
    expect(row.reason).toContain('E_RECIPIENT_SUPPRESSED')
  })

  it('records email_send_failed on other provider errors', async () => {
    const db = getDb(env.DB)
    const EMAIL = { send: vi.fn().mockRejectedValue(Object.assign(new Error('slow down'), { code: 'E_RATE_LIMIT_EXCEEDED' })) }
    await sendMagicLink('a@b.com', 'http://localhost/x', baseEnv({ EMAIL }), 'login', db, 'user-1').catch(() => {})
    const [row] = await db.select().from(authEvents).all()
    expect(row.event).toBe('email_send_failed')
    expect(row.reason).toContain('E_RATE_LIMIT_EXCEEDED')
  })
})
