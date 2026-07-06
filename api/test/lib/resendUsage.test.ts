import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { getDb } from '../../src/db/client'
import { associationConfig } from '../../src/db/schema'
import { eq } from 'drizzle-orm'
import { resetDb, applyMigrations } from '../helpers'
import { recordResendUsage, recordResendThrottle } from '../../src/lib/resendUsage'

beforeEach(async () => { await resetDb(); await applyMigrations() })

function resWith(headers: Record<string, string>, status = 200): Response {
  return new Response('{}', { status, headers })
}

describe('recordResendUsage', () => {
  it('persists readings + timestamp', async () => {
    const db = getDb(env.DB)
    await recordResendUsage(db, resWith({ 'x-resend-monthly-quota': '900', 'x-resend-daily-quota': '12' }))
    const monthly = await db.select().from(associationConfig).where(eq(associationConfig.key, 'resend_monthly_used')).get()
    const usedAt = await db.select().from(associationConfig).where(eq(associationConfig.key, 'resend_used_at')).get()
    expect(monthly?.value).toBe('900')
    expect(usedAt?.value).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
  })
  it('no-ops when no headers present', async () => {
    const db = getDb(env.DB)
    await recordResendUsage(db, resWith({}))
    const monthly = await db.select().from(associationConfig).where(eq(associationConfig.key, 'resend_monthly_used')).get()
    expect(monthly).toBeUndefined()
  })
})

describe('recordResendThrottle', () => {
  it('stamps resend_last_429_at on a 429', async () => {
    const db = getDb(env.DB)
    await recordResendThrottle(db, resWith({}, 429))
    const row = await db.select().from(associationConfig).where(eq(associationConfig.key, 'resend_last_429_at')).get()
    expect(row?.value).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
  })
  it('does nothing on a 200', async () => {
    const db = getDb(env.DB)
    await recordResendThrottle(db, resWith({}, 200))
    const row = await db.select().from(associationConfig).where(eq(associationConfig.key, 'resend_last_429_at')).get()
    expect(row).toBeUndefined()
  })
})
