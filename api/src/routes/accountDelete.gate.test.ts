import { describe, it, expect, beforeEach } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { resetDb, applyMigrations, seedUser, seedSession } from '../../test/helpers'
import { getDb } from '../db/client'
import { associationConfig, users } from '../db/schema'
import { eq } from 'drizzle-orm'

async function enableDeletion() {
  await getDb(env.DB).insert(associationConfig).values({ key: 'account_deletion_enabled', value: 'true' })
}

describe('hard-delete gating', () => {
  beforeEach(async () => { await resetDb(); await applyMigrations() })

  it('DELETE /admin/members/:id is 403 when disabled, ok when enabled', async () => {
    const ownerTok = await seedSession(await seedUser({ role: 'owner', email: 'o@x.com' }))
    const targetId = await seedUser({ role: 'member', email: 't@x.com' })

    const blocked = await SELF.fetch(`https://x/api/admin/members/${targetId}`, { method: 'DELETE', headers: { Cookie: `session=${ownerTok}` } })
    expect(blocked.status).toBe(403)
    expect(await getDb(env.DB).select().from(users).where(eq(users.id, targetId)).get()).toBeDefined()

    await enableDeletion()
    const ok = await SELF.fetch(`https://x/api/admin/members/${targetId}`, { method: 'DELETE', headers: { Cookie: `session=${ownerTok}` } })
    expect(ok.status).toBe(200)
    expect(await getDb(env.DB).select().from(users).where(eq(users.id, targetId)).get()).toBeUndefined()
  })

  it('DELETE /users/me is 403 when disabled, ok when enabled', async () => {
    const meId = await seedUser({ role: 'member', email: 'me@x.com' })
    const meTok = await seedSession(meId)
    const blocked = await SELF.fetch('https://x/api/users/me', { method: 'DELETE', headers: { Cookie: `session=${meTok}` } })
    expect(blocked.status).toBe(403)

    await enableDeletion()
    const meTok2 = await seedSession(meId)
    const ok = await SELF.fetch('https://x/api/users/me', { method: 'DELETE', headers: { Cookie: `session=${meTok2}` } })
    expect(ok.status).toBe(200)
    expect(await getDb(env.DB).select().from(users).where(eq(users.id, meId)).get()).toBeUndefined()
  })
})
