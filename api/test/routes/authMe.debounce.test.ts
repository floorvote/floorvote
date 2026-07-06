import { env } from 'cloudflare:test'
import { describe, it, expect, beforeEach } from 'vitest'
import { app } from '../../src/index'
import { resetDb, applyMigrations, seedUser, seedSession } from '../helpers'
import { getDb } from '../../src/db/client'
import { users } from '../../src/db/schema'
import { eq } from 'drizzle-orm'

beforeEach(async () => {
  await resetDb()
  await applyMigrations()
})

// Format an instant as SQLite space-format UTC ("YYYY-MM-DD HH:MM:SS").
function spaceTs(date: Date): string {
  return date.toISOString().slice(0, 19).replace('T', ' ')
}

describe('GET /auth/me — users.lastActive write debounce', () => {
  it('does not rewrite users.last_active on a second immediate call', async () => {
    const db = getDb(env.DB)
    const userId = await seedUser({ email: 'debounce-fresh@example.com' })
    const rawToken = await seedSession(userId)

    // Seed a recent (now-ish) last_active so the debounce window applies.
    await db.update(users).set({ lastActive: spaceTs(new Date()) }).where(eq(users.id, userId))

    const res1 = await app.request('/api/auth/me', { headers: { Cookie: `session=${rawToken}` } }, env)
    expect(res1.status).toBe(200)
    const body1 = await res1.json() as { id: string; email: string }
    expect(body1.email).toBe('debounce-fresh@example.com')

    const after1 = (await db.select({ lastActive: users.lastActive }).from(users).where(eq(users.id, userId)).get())!.lastActive

    // Immediate second call — value is fresh, so the write must be skipped.
    const res2 = await app.request('/api/auth/me', { headers: { Cookie: `session=${rawToken}` } }, env)
    expect(res2.status).toBe(200)
    const after2 = (await db.select({ lastActive: users.lastActive }).from(users).where(eq(users.id, userId)).get())!.lastActive

    expect(after2).toBe(after1)
  })

  it('updates users.last_active when the stored value is older than 5 minutes', async () => {
    const db = getDb(env.DB)
    const userId = await seedUser({ email: 'debounce-stale@example.com' })
    const rawToken = await seedSession(userId)

    // Stale value, 10 minutes in the past, in space-format UTC.
    const stale = spaceTs(new Date(Date.now() - 10 * 60 * 1000))
    await db.update(users).set({ lastActive: stale }).where(eq(users.id, userId))

    const res = await app.request('/api/auth/me', { headers: { Cookie: `session=${rawToken}` } }, env)
    expect(res.status).toBe(200)
    const body = await res.json() as { id: string; email: string }
    expect(body.email).toBe('debounce-stale@example.com')

    const after = (await db.select({ lastActive: users.lastActive }).from(users).where(eq(users.id, userId)).get())!.lastActive
    expect(after).not.toBe(stale)

    // The new value should be ~now (within a minute), not the stale one.
    const { dbTsToEpoch } = await import('../../../shared/time')
    expect(Math.abs(dbTsToEpoch(after) - Date.now())).toBeLessThan(60 * 1000)
  })
})
