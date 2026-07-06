import { describe, it, expect, beforeEach } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { resetDb, applyMigrations, seedUser, seedSession } from '../helpers'
import { getDb } from '../../src/db/client'
import { users } from '../../src/db/schema'
import { eq } from 'drizzle-orm'

describe('PATCH /api/users/me email digest pref', () => {
  let uid: string, token: string
  beforeEach(async () => {
    await resetDb(); await applyMigrations()
    uid = await seedUser({ email: 'm@e.com' }); token = await seedSession(uid)
  })
  it('toggles email_digest_enabled for the current user', async () => {
    const r = await SELF.fetch('http://localhost/api/users/me', {
      method: 'PATCH', headers: { Cookie: `session=${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ emailDigestEnabled: false }),
    })
    expect(r.status).toBe(200)
    const row = await getDb(env.DB).select().from(users).where(eq(users.id, uid)).get()
    expect(row!.emailDigestEnabled).toBe(0)
  })
  it('requires auth', async () => {
    const r = await SELF.fetch('http://localhost/api/users/me', { method: 'PATCH', body: '{}' })
    expect(r.status).toBe(401)
  })
})
