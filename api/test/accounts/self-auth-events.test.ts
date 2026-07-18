import { describe, it, expect, beforeEach } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { resetDb, applyMigrations, seedUser, seedSession, seedAuthEvent } from '../helpers'
import { getDb } from '../../src/db/client'
import { authEvents } from '../../src/db/schema'

describe('GET /users/me/auth-events', () => {
  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
  })

  it("returns only the caller's own events, newest first", async () => {
    const meId = await seedUser({ role: 'member', email: 'me@x.com' })
    const meTok = await seedSession(meId)
    const otherId = await seedUser({ role: 'member', email: 'other@x.com' })

    // seedAuthEvent's default createdAt (datetime('now')) has second resolution, which risks
    // ties between the two rows below — set explicit, distinct timestamps for a deterministic order check.
    const db = getDb(env.DB)
    await db.insert(authEvents).values({
      id: crypto.randomUUID(), userId: meId, email: 'me@x.com',
      event: 'verify_success', createdAt: '2026-01-01 00:00:00',
    })
    await db.insert(authEvents).values({
      id: crypto.randomUUID(), userId: meId, email: 'me@x.com',
      event: 'link_requested', linkType: 'login', createdAt: '2026-01-01 00:00:01',
    })
    await seedAuthEvent(otherId, 'verify_success')

    const res = await SELF.fetch('https://x/api/users/me/auth-events', {
      headers: { Cookie: `session=${meTok}` },
    })
    expect(res.status).toBe(200)
    const body = await res.json<{ events: Array<{ id: string; event: string; reason: string | null; linkType: string | null; provider: string | null; ipCountry: string | null; createdAt: string }> }>()
    expect(body.events.length).toBe(2)
    expect(body.events.map((e) => e.event)).toEqual(['link_requested', 'verify_success'])
    expect(body).not.toHaveProperty('suppression')
    expect(body).not.toHaveProperty('delivery')
  })

  it('requires auth', async () => {
    const res = await SELF.fetch('https://x/api/users/me/auth-events')
    expect(res.status).toBe(401)
  })
})
