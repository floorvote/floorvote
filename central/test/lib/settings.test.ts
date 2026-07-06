import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import { eq } from 'drizzle-orm'
import * as schema from '../../src/db/schema-legiscan'
import { setupLsDb } from '../helpers/setupLsDb'
import { getSetting, getSettingNumber, setSetting } from '../../src/lib/settings'

beforeEach(async () => { await setupLsDb() })

describe('settings helpers', () => {
  it('reads a seeded default', async () => {
    const db = drizzle(env.DB, { schema })
    expect(await getSetting(db, 'legiscan_monthly_limit', 'x')).toBe('30000')
    expect(await getSettingNumber(db, 'legiscan_monthly_limit', 1)).toBe(30000)
  })

  it('returns fallback for an unknown key', async () => {
    const db = drizzle(env.DB, { schema })
    expect(await getSetting(db, 'nope', 'fallback')).toBe('fallback')
    expect(await getSettingNumber(db, 'nope', 42)).toBe(42)
  })

  it('returns fallback when value is non-numeric for getSettingNumber', async () => {
    const db = drizzle(env.DB, { schema })
    await setSetting(db, 'resend_used_at', '')
    expect(await getSettingNumber(db, 'resend_used_at', 7)).toBe(7)
  })

  it('setSetting upserts and bumps updated_at', async () => {
    const db = drizzle(env.DB, { schema })
    await setSetting(db, 'legiscan_monthly_limit', '40000')
    expect(await getSetting(db, 'legiscan_monthly_limit', 'x')).toBe('40000')
    const row = await db.select().from(schema.settings).where(eq(schema.settings.key, 'legiscan_monthly_limit')).get()
    expect(row?.value).toBe('40000')
    expect(row?.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
  })
})
