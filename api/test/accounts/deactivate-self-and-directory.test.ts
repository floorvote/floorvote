import { describe, it, expect, beforeEach } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { resetDb, applyMigrations, seedUser, seedSession } from '../helpers'
import { getDb } from '../../src/db/client'
import { users } from '../../src/db/schema'
import { eq } from 'drizzle-orm'

describe('GET /users excludes deactivated members', () => {
  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
  })

  it('omits a deactivated member and includes an active one', async () => {
    const meTok = await seedSession(await seedUser({ role: 'admin', email: 'a@x.com' }))
    await seedUser({ role: 'member', email: 'active@x.com' })
    await seedUser({ role: 'member', email: 'gone@x.com', deactivatedAt: new Date().toISOString() })

    const res = await SELF.fetch('https://x/api/users', { headers: { Cookie: `session=${meTok}` } })
    expect(res.status).toBe(200)
    const emails = (await res.json<Array<{ email: string }>>()).map((u) => u.email)
    expect(emails).toContain('active@x.com')
    expect(emails).not.toContain('gone@x.com')
  })
})

describe('POST /users/me/deactivate', () => {
  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
  })

  it('deactivates the caller and logs them out', async () => {
    const meId = await seedUser({ role: 'member', email: 'me@x.com' })
    const meTok = await seedSession(meId)

    const res = await SELF.fetch('https://x/api/users/me/deactivate', {
      method: 'POST',
      headers: { Cookie: `session=${meTok}` },
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })

    const row = await getDb(env.DB).select().from(users).where(eq(users.id, meId)).get()
    expect(row?.deactivatedAt).toBeTruthy()

    // session invalidated → a follow-up authed call is 401
    const after = await SELF.fetch('https://x/api/users/me/deactivate', {
      method: 'POST',
      headers: { Cookie: `session=${meTok}` },
    })
    expect(after.status).toBe(401)
  })
})
