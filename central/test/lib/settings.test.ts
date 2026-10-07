import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import { eq } from 'drizzle-orm'
import * as schema from '../../src/db/schema-legiscan'
import { setupLsDb } from '../helpers/setupLsDb'
import { getSetting, getSettingNumber, setSetting } from '../../src/lib/settings'
import migration0020 from '../../migrations-legiscan/0020_legiscan_limit_10k.sql?raw'

beforeEach(async () => { await setupLsDb() })

describe('settings helpers', () => {
  it('reads a seeded default', async () => {
    const db = drizzle(env.DB, { schema })
    expect(await getSetting(db, 'legiscan_monthly_limit', 'x')).toBe('10000')
    expect(await getSettingNumber(db, 'legiscan_monthly_limit', 1)).toBe(10000)
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

// 0020 moves the old 30k free-tier seed to 10k. Re-run it against a known value
// to pin which rows it may touch.
describe('0020 legiscan limit migration', () => {
  const rerun = () => env.DB.exec(migration0020.replace(/--.*$/gm, '').replace(/\s+/g, ' ').trim())

  it('rewrites the untouched 30k seed to 10k', async () => {
    const db = drizzle(env.DB, { schema })
    await setSetting(db, 'legiscan_monthly_limit', '30000')
    await rerun()
    expect(await getSettingNumber(db, 'legiscan_monthly_limit', 1)).toBe(10000)
  })

  it('leaves a central on its own plan alone', async () => {
    const db = drizzle(env.DB, { schema })
    await setSetting(db, 'legiscan_monthly_limit', '40000')
    await rerun()
    expect(await getSettingNumber(db, 'legiscan_monthly_limit', 1)).toBe(40000)
  })

  it('is a no-op once already at 10k', async () => {
    const db = drizzle(env.DB, { schema })
    await rerun()
    expect(await getSettingNumber(db, 'legiscan_monthly_limit', 1)).toBe(10000)
  })

  it('touches no other setting', async () => {
    const db = drizzle(env.DB, { schema })
    await setSetting(db, 'resend_monthly_limit', '30000')
    await rerun()
    expect(await getSetting(db, 'resend_monthly_limit', 'x')).toBe('30000')
  })
})
