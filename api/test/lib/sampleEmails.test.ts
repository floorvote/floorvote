import { describe, it, expect, beforeEach, vi } from 'vitest'
import { env } from 'cloudflare:test'
import { resetDb, applyMigrations } from '../helpers'
import { getDb } from '../../src/db/client'
import { emailSendStats } from '../../src/db/schema'
import { sendSampleEmail } from '../../src/lib/sampleEmails'

describe('sendSampleEmail', () => {
  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
  })

  it('does not count toward email_send_stats, so a sample cannot mask a failing provider', async () => {
    const send = vi.fn(async () => ({ messageId: 'cf-1' }))
    const e = { ...env, EMAIL_PROVIDER: 'cloudflare', EMAIL: { send }, APP_URL: 'https://ut.example.test', EMAIL_FROM: 'n@example.test' }
    const db = getDb(env.DB)
    const r = await sendSampleEmail(e as never, db, 'qa@example.test', 'login')
    expect(r.ok).toBe(true)
    expect(send).toHaveBeenCalledOnce()
    expect(await db.select().from(emailSendStats).all()).toHaveLength(0)
  })
})
