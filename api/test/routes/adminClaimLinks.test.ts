import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { env } from 'cloudflare:test'
import { app } from '../../src/index'
import { clearDb, seedUser, seedSession } from '../helpers'
import { getDb } from '../../src/db/client'
import { associationConfig } from '../../src/db/schema'
import { claimLinksEnabled } from '../../src/lib/claimSources'

// The per-instance claim links setting (#570): on by default, admins can turn
// it off, and the change records who made it and when.

vi.mock('../../src/lib/centralFetch', () => ({
  centralFetch: vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }),
}))
vi.mock('../../src/cron/sync', () => ({
  registerWithCentral: vi.fn().mockResolvedValue(undefined),
}))

type ConfigBody = {
  claim_links_enabled?: boolean
  claim_links_changed_at?: string | null
  claim_links_changed_by?: { id: string; name: string | null; email: string } | null
}

describe('the claim links setting (admin API)', () => {
  let adminId: string
  let adminCookie: string
  let ownerId: string
  let ownerCookie: string
  let memberCookie: string
  const db = () => getDb(env.DB)

  const put = (cookie: string | null, body: unknown, e: Record<string, unknown> = env) =>
    app.request('/api/admin/claim-links', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: JSON.stringify(body),
    }, e)
  const config = async (cookie = adminCookie) => {
    const res = await app.request('/api/admin/config', { headers: { Cookie: cookie } }, env)
    expect(res.status).toBe(200)
    return await res.json() as ConfigBody
  }
  const rows = async () => (await db().select().from(associationConfig).all())
    .filter(r => r.key.startsWith('claim_links'))

  beforeEach(async () => {
    await clearDb()
    adminId = await seedUser({ role: 'admin', email: 'admin@example.com', name: 'Avery Admin' })
    adminCookie = `session=${await seedSession(adminId)}`
    ownerId = await seedUser({ role: 'owner', email: 'owner@example.com', name: 'Olive Owner' })
    ownerCookie = `session=${await seedSession(ownerId)}`
    memberCookie = `session=${await seedSession(await seedUser({ role: 'member', email: 'member@example.com', name: 'Mo Member' }))}`
  })

  afterEach(() => { vi.useRealTimers() })

  describe('the default', () => {
    it('reads as on for a new instance, with nothing recorded', async () => {
      const body = await config()
      expect(body.claim_links_enabled).toBe(true)
      expect(body.claim_links_changed_at ?? null).toBeNull()
      expect(body.claim_links_changed_by ?? null).toBeNull()
      expect(await claimLinksEnabled(db())).toBe(true)
      expect(await rows()).toEqual([])
    })

    it('reads as on for an existing instance that has AI settings of its own and no claim links row', async () => {
      await db().insert(associationConfig).values([
        { key: 'ai_context', value: JSON.stringify('Summarize for clerks.') },
        { key: 'relevance_question', value: JSON.stringify('How much does this touch ballots?') },
        { key: 'tag_taxonomy', value: JSON.stringify([{ name: 'Voting' }]) },
      ])
      expect((await config()).claim_links_enabled).toBe(true)
      expect(await claimLinksEnabled(db())).toBe(true)
    })
  })

  describe('turning it off and on', () => {
    it('lets an admin turn it off, and both the read and the flag follow', async () => {
      const res = await put(adminCookie, { enabled: false })
      expect(res.status).toBe(200)
      expect(await res.json()).toMatchObject({ enabled: false })
      expect((await config()).claim_links_enabled).toBe(false)
      expect(await claimLinksEnabled(db())).toBe(false)
    })

    it('lets an owner change it too', async () => {
      expect((await put(ownerCookie, { enabled: false })).status).toBe(200)
      expect(await claimLinksEnabled(db())).toBe(false)
    })

    it('turns back on, and the read follows', async () => {
      await put(adminCookie, { enabled: false })
      const res = await put(adminCookie, { enabled: true })
      expect(res.status).toBe(200)
      expect((await config()).claim_links_enabled).toBe(true)
      expect(await claimLinksEnabled(db())).toBe(true)
    })

    it('treats a repeated off as off, not a toggle', async () => {
      await put(adminCookie, { enabled: false })
      await put(adminCookie, { enabled: false })
      expect(await claimLinksEnabled(db())).toBe(false)
    })

    it('reads a stored bare "false" (an older-style row) as off', async () => {
      await db().insert(associationConfig).values({ key: 'claim_links_enabled', value: 'false' })
      expect(await claimLinksEnabled(db())).toBe(false)
    })

    it('reads an unreadable stored value as on, the default', async () => {
      await db().insert(associationConfig).values({ key: 'claim_links_enabled', value: '{not json' })
      expect(await claimLinksEnabled(db())).toBe(true)
      await db().update(associationConfig).set({ value: JSON.stringify('maybe') })
      expect(await claimLinksEnabled(db())).toBe(true)
    })
  })

  describe('who can change it', () => {
    it('refuses a member with 403 and changes nothing', async () => {
      const res = await put(memberCookie, { enabled: false })
      expect(res.status).toBe(403)
      expect(await claimLinksEnabled(db())).toBe(true)
      expect(await rows()).toEqual([])
    })

    it('refuses a member trying to turn it back on, leaving it off', async () => {
      await put(adminCookie, { enabled: false })
      const before = await rows()
      expect((await put(memberCookie, { enabled: true })).status).toBe(403)
      expect(await claimLinksEnabled(db())).toBe(false)
      expect(await rows()).toEqual(before)
    })

    it('refuses a request with no session with 401', async () => {
      const res = await put(null, { enabled: false })
      expect(res.status).toBe(401)
      expect(await claimLinksEnabled(db())).toBe(true)
    })

    it('does not let a member read the admin config that carries it', async () => {
      const res = await app.request('/api/admin/config', { headers: { Cookie: memberCookie } }, env)
      expect(res.status).toBe(403)
    })

    it('is not writable through PUT /admin/config, which would skip the record of who changed it', async () => {
      const res = await app.request('/api/admin/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
        body: JSON.stringify({ claim_links_enabled: false }),
      }, env)
      expect(res.status).toBe(400)
      expect(await claimLinksEnabled(db())).toBe(true)
    })

    it('is locked on a demo instance, like the other settings', async () => {
      const res = await put(adminCookie, { enabled: false }, { ...env, DEMO_MODE: 'true' })
      expect(res.status).toBe(403)
      expect(await claimLinksEnabled(db())).toBe(true)
    })
  })

  describe('validation', () => {
    it.each([
      ['a missing enabled', {}],
      ['the string "false"', { enabled: 'false' }],
      ['a number', { enabled: 0 }],
      ['null', { enabled: null }],
    ])('rejects %s with 400 and changes nothing', async (_label, body) => {
      const res = await put(adminCookie, body)
      expect(res.status).toBe(400)
      expect(await claimLinksEnabled(db())).toBe(true)
      expect(await rows()).toEqual([])
    })

    it('rejects a body that is not JSON with 400', async () => {
      const res = await app.request('/api/admin/claim-links', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
        body: '{nope',
      }, env)
      expect(res.status).toBe(400)
    })
  })

  describe('recording who and when', () => {
    it('records the admin and the time on a change, and shows them in the admin config', async () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date('2026-10-20T14:05:09Z'))
      const res = await put(adminCookie, { enabled: false })
      expect(res.status).toBe(200)
      expect(await res.json()).toMatchObject({
        enabled: false,
        changedAt: '2026-10-20 14:05:09',
        changedBy: { id: adminId, name: 'Avery Admin', email: 'admin@example.com' },
      })
      const body = await config()
      expect(body.claim_links_changed_at).toBe('2026-10-20 14:05:09')
      expect(body.claim_links_changed_by).toEqual({ id: adminId, name: 'Avery Admin', email: 'admin@example.com' })
    })

    it('records the latest change, so turning it back on names whoever did that', async () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date('2026-10-20T14:05:09Z'))
      await put(adminCookie, { enabled: false })
      vi.setSystemTime(new Date('2026-10-21T08:00:00Z'))
      await put(ownerCookie, { enabled: true })
      const body = await config()
      expect(body.claim_links_enabled).toBe(true)
      expect(body.claim_links_changed_at).toBe('2026-10-21 08:00:00')
      expect(body.claim_links_changed_by).toEqual({ id: ownerId, name: 'Olive Owner', email: 'owner@example.com' })
    })

    it('does not record a refused change', async () => {
      await put(memberCookie, { enabled: false })
      await put(adminCookie, { enabled: 'no' })
      expect((await config()).claim_links_changed_by ?? null).toBeNull()
    })

    it('keeps the record when the admin is later removed, without naming a person', async () => {
      await put(adminCookie, { enabled: false })
      await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(adminId).run()
      await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(adminId).run()
      const body = await config(ownerCookie)
      expect(body.claim_links_enabled).toBe(false)
      expect(body.claim_links_changed_at).toBeTruthy()
      expect(body.claim_links_changed_by ?? null).toBeNull()
    })
  })
})
