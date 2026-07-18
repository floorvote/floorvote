import { describe, it, expect, beforeEach } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { resetDb, applyMigrations, seedUser, seedSession } from '../../test/helpers'

describe('PUT /api/admin/deletion-policy + config exposure', () => {
  beforeEach(async () => { await resetDb(); await applyMigrations() })

  it('lets an owner enable deletion and reflects it in both config reads', async () => {
    const ownerTok = await seedSession(await seedUser({ role: 'owner', email: 'o@x.com' }))
    const put = await SELF.fetch('https://x/api/admin/deletion-policy', {
      method: 'PUT', headers: { Cookie: `session=${ownerTok}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    })
    expect(put.status).toBe(200)
    expect(await put.json()).toEqual({ enabled: true })

    const adminCfg = await SELF.fetch('https://x/api/admin/config', { headers: { Cookie: `session=${ownerTok}` } })
    expect((await adminCfg.json<{ accountDeletionEnabled: boolean }>()).accountDeletionEnabled).toBe(true)

    const memberTok = await seedSession(await seedUser({ role: 'member', email: 'm@x.com' }))
    const cfg = await SELF.fetch('https://x/api/config', { headers: { Cookie: `session=${memberTok}` } })
    expect((await cfg.json<{ accountDeletionEnabled: boolean }>()).accountDeletionEnabled).toBe(true)
  })

  it('rejects a non-owner (admin) with 403 and defaults to disabled', async () => {
    const adminTok = await seedSession(await seedUser({ role: 'admin', email: 'a@x.com' }))
    const put = await SELF.fetch('https://x/api/admin/deletion-policy', {
      method: 'PUT', headers: { Cookie: `session=${adminTok}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    })
    expect(put.status).toBe(403)
    const cfg = await SELF.fetch('https://x/api/config', { headers: { Cookie: `session=${adminTok}` } })
    expect((await cfg.json<{ accountDeletionEnabled: boolean }>()).accountDeletionEnabled).toBe(false)
  })
})
