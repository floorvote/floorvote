import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { resetDb, applyMigrations } from '../helpers'
import { getDb } from '../../src/db/client'
import { authEvents } from '../../src/db/schema'
import { recordAuthEvent, authReqContext } from '../../src/lib/authEvents'

describe('recordAuthEvent', () => {
  beforeEach(async () => { await resetDb(); await applyMigrations() })

  it('writes a row with all provided fields', async () => {
    const db = getDb(env.DB)
    await recordAuthEvent(db, {
      event: 'verify_failed', email: 'a@b.com', userId: 'u1', reason: 'expired',
      linkType: 'login', userAgent: 'UA', ipCountry: 'US',
    })
    const [row] = await db.select().from(authEvents).all()
    expect(row.event).toBe('verify_failed')
    expect(row.reason).toBe('expired')
    expect(row.userId).toBe('u1')
    expect(row.ipCountry).toBe('US')
  })

  it('never throws on a DB failure (best-effort)', async () => {
    const fakeDb = { insert: () => ({ values: () => Promise.reject(new Error('boom')) }) } as never
    await expect(recordAuthEvent(fakeDb, { event: 'logout', email: 'a@b.com' })).resolves.toBeUndefined()
  })

  it('authReqContext pulls UA and cf-ipcountry', () => {
    const c = { req: { header: (n: string) => ({ 'user-agent': 'UA', 'cf-ipcountry': 'GB' } as Record<string, string>)[n.toLowerCase()] } }
    expect(authReqContext(c)).toEqual({ userAgent: 'UA', ipCountry: 'GB' })
  })
})
