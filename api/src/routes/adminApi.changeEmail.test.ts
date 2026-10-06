import { describe, it, expect, vi, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { eq } from 'drizzle-orm'
import { app } from '../index'
import { resetDb, applyMigrations, seedUser, seedSession, seedMagicLink } from '../../test/helpers'
import { getDb } from '../db/client'
import { users, magicLinks, authEvents } from '../db/schema'
import { sendMagicLink } from '../lib/email'

vi.mock('../lib/centralFetch', () => ({
  centralFetch: vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }),
}))
vi.mock('../cron/sync', () => ({ registerWithCentral: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../lib/email', () => ({ sendMagicLink: vi.fn().mockResolvedValue(undefined) }))

const UNCHANGED = "That's already their address. Check it for a typo, or use Resend invite to send to it again."
const IN_USE = 'Another member already uses that address.'
const SUPPRESSED = 'This address has bounced before. Check it for a typo.'
const INVALID = 'Invalid email address'

type Suppression = { suppressed: boolean | null; reason?: string }

/** A central binding whose suppression lookup answers with `answer` (or throws it). */
function centralWith(answer: Suppression | Error) {
  return {
    emailSuppression: vi.fn(async () => {
      if (answer instanceof Error) throw answer
      return answer
    }),
  }
}

describe('POST /admin/members/:id/change-email', () => {
  let adminId: string
  let adminCookie: string
  let pendingId: string

  async function seedPending(email: string, overrides: { role?: 'admin' | 'member' | 'owner'; deactivatedAt?: string } = {}) {
    const id = await seedUser({ email, name: 'Pending Person', ...overrides })
    await getDb(env.DB).update(users).set({ invitedBy: adminId }).where(eq(users.id, id))
    return id
  }

  async function changeEmail(
    targetId: string,
    email: unknown,
    opts: { cookie?: string; central?: unknown } = {},
  ) {
    const res = await app.request(`/api/admin/members/${targetId}/change-email`, {
      method: 'POST',
      headers: { Cookie: opts.cookie ?? adminCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    }, { ...env, CENTRAL: (opts.central ?? centralWith({ suppressed: false })) as Fetcher })
    return { status: res.status, body: await res.json() as { ok?: boolean; email?: string; error?: string } }
  }

  async function memberRow(id: string) {
    return (await getDb(env.DB).select().from(users).where(eq(users.id, id)).get())!
  }

  async function eventsFor(id: string, event: string) {
    return getDb(env.DB).select().from(authEvents).where(eq(authEvents.userId, id)).all()
      .then(rows => rows.filter(r => r.event === event))
  }

  beforeEach(async () => {
    vi.mocked(sendMagicLink).mockClear()
    await resetDb()
    await applyMigrations()
    adminId = await seedUser({ role: 'admin', email: 'admin@example.com', name: 'Ada Admin' })
    adminCookie = `session=${await seedSession(adminId)}`
    pendingId = await seedPending('jane@exmaple.com')
  })

  describe('success', () => {
    it('updates the address, records the change, and sends a new invite to the new address', async () => {
      const r = await changeEmail(pendingId, 'jane@example.com')
      expect(r.status).toBe(200)
      expect(r.body).toEqual({ ok: true, email: 'jane@example.com' })

      expect((await memberRow(pendingId)).email).toBe('jane@example.com')

      const [changed] = await eventsFor(pendingId, 'email_changed')
      expect(changed).toMatchObject({ email: 'jane@example.com', reason: 'jane@exmaple.com', actorId: adminId })

      // Sent the way Resend invite sends: an invite link to the new address.
      expect(sendMagicLink).toHaveBeenCalledTimes(1)
      const [to, , , linkType, , userId] = vi.mocked(sendMagicLink).mock.calls[0]
      expect([to, linkType, userId]).toEqual(['jane@example.com', 'invite', pendingId])
      const [requested] = await eventsFor(pendingId, 'link_requested')
      expect(requested).toMatchObject({ email: 'jane@example.com', linkType: 'invite' })

      // One fresh, unused, seven-day invite link.
      const links = await getDb(env.DB).select().from(magicLinks).where(eq(magicLinks.userId, pendingId)).all()
      expect(links).toHaveLength(1)
      expect(new Date(links[0].expiresAt).getTime() - Date.now()).toBeGreaterThan(6 * 24 * 60 * 60 * 1000)
    })

    it('normalizes the new address: trims and lowercases it before storing', async () => {
      const r = await changeEmail(pendingId, '  Jane.Doe@Example.COM ')
      expect(r.status).toBe(200)
      expect(r.body.email).toBe('jane.doe@example.com')
      expect((await memberRow(pendingId)).email).toBe('jane.doe@example.com')
    })

    it('makes the old invite links unusable while the new one works', async () => {
      const oldToken = await seedMagicLink(pendingId)
      const olderToken = await seedMagicLink(pendingId)

      expect((await changeEmail(pendingId, 'jane@example.com')).status).toBe(200)

      for (const token of [oldToken, olderToken]) {
        const res = await app.request('/api/auth/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token }),
        }, env)
        expect(res.status).not.toBe(200)
      }

      const url = vi.mocked(sendMagicLink).mock.calls[0][1]
      const newToken = new URL(url).searchParams.get('token')!
      const res = await app.request('/api/auth/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: newToken }),
      }, env)
      expect(res.status).toBe(200)
    })

    it('lets an Owner change a pending Owner', async () => {
      const ownerId = await seedUser({ role: 'owner', email: 'owner@example.com' })
      const ownerCookie = `session=${await seedSession(ownerId)}`
      const pendingOwner = await seedPending('boss@exmaple.com', { role: 'owner' })
      const r = await changeEmail(pendingOwner, 'boss@example.com', { cookie: ownerCookie })
      expect(r.status).toBe(200)
      expect((await memberRow(pendingOwner)).email).toBe('boss@example.com')
    })

    it('goes through when the suppression lookup fails', async () => {
      const r = await changeEmail(pendingId, 'jane@example.com', { central: centralWith(new Error('lookup down')) })
      expect(r.status).toBe(200)
      expect((await memberRow(pendingId)).email).toBe('jane@example.com')
    })

    it('goes through when the lookup cannot tell (suppressed: null) or no central binding exists', async () => {
      expect((await changeEmail(pendingId, 'jane@example.com', { central: centralWith({ suppressed: null }) })).status).toBe(200)
      const other = await seedPending('pat@exmaple.com')
      expect((await changeEmail(other, 'pat@example.com', { central: {} })).status).toBe(200)
    })

    it('asks the suppression lookup about the new, normalized address', async () => {
      const central = centralWith({ suppressed: false })
      await changeEmail(pendingId, ' Jane@Example.com', { central })
      expect(central.emailSuppression).toHaveBeenCalledWith('jane@example.com')
    })
  })

  describe('refusals that leave the member untouched', () => {
    async function expectUntouched(id: string, email: string) {
      expect((await memberRow(id)).email).toBe(email)
      expect(await eventsFor(id, 'email_changed')).toHaveLength(0)
      expect(sendMagicLink).not.toHaveBeenCalled()
    }

    it.each([
      ['the same address', 'jane@exmaple.com'],
      ['a different case', 'JANE@Exmaple.COM'],
      ['surrounding spaces', '  jane@exmaple.com  '],
    ])('refuses an unchanged address (%s) and points to Resend invite', async (_label, email) => {
      const oldToken = await seedMagicLink(pendingId)
      const r = await changeEmail(pendingId, email)
      expect(r).toEqual({ status: 400, body: { error: UNCHANGED } })
      await expectUntouched(pendingId, 'jane@exmaple.com')
      // The existing link still works: a refused change cancels nothing.
      const links = await getDb(env.DB).select().from(magicLinks).where(eq(magicLinks.userId, pendingId)).all()
      expect(links).toHaveLength(1)
      expect(oldToken).toBeTruthy()
    })

    it('treats a mixed-case stored address as unchanged', async () => {
      const mixed = await seedPending('Pat.Lee@Exmaple.COM')
      const r = await changeEmail(mixed, 'pat.lee@exmaple.com')
      expect(r).toEqual({ status: 400, body: { error: UNCHANGED } })
      await expectUntouched(mixed, 'Pat.Lee@Exmaple.COM')
    })

    it('refuses an address an active member uses', async () => {
      await seedUser({ email: 'taken@example.com' })
      expect(await changeEmail(pendingId, 'taken@example.com')).toEqual({ status: 409, body: { error: IN_USE } })
      await expectUntouched(pendingId, 'jane@exmaple.com')
    })

    it('refuses an address a deactivated member uses', async () => {
      await seedUser({ email: 'gone@example.com', deactivatedAt: '2026-01-01 00:00:00' })
      expect(await changeEmail(pendingId, 'gone@example.com')).toEqual({ status: 409, body: { error: IN_USE } })
      await expectUntouched(pendingId, 'jane@exmaple.com')
    })

    it('refuses an address another member uses in a different case, typed or stored', async () => {
      await seedUser({ email: 'taken@example.com' })
      await seedUser({ email: 'Mixed.Case@Example.COM' })
      expect(await changeEmail(pendingId, 'TAKEN@example.com')).toEqual({ status: 409, body: { error: IN_USE } })
      expect(await changeEmail(pendingId, 'mixed.case@example.com')).toEqual({ status: 409, body: { error: IN_USE } })
      await expectUntouched(pendingId, 'jane@exmaple.com')
    })

    it.each([
      ['malformed', 'not-an-email'],
      ['blank', '   '],
      ['trailing punctuation', 'jane@example.com;'],
      ['missing', undefined],
      ['not a string', 42],
    ])('refuses a %s address with the standard invalid-address message', async (_label, email) => {
      expect(await changeEmail(pendingId, email)).toEqual({ status: 400, body: { error: INVALID } })
      await expectUntouched(pendingId, 'jane@exmaple.com')
    })

    it('refuses a suppressed address', async () => {
      const central = centralWith({ suppressed: true, reason: 'hard bounce' })
      expect(await changeEmail(pendingId, 'jane@example.com', { central })).toEqual({ status: 400, body: { error: SUPPRESSED } })
      await expectUntouched(pendingId, 'jane@exmaple.com')
    })

    it('refuses a member who has signed in', async () => {
      await seedMagicLink(pendingId, { used: true })
      const r = await changeEmail(pendingId, 'jane@example.com')
      expect(r.status).toBe(400)
      expect(r.body.error).toMatch(/pending invite/i)
      await expectUntouched(pendingId, 'jane@exmaple.com')
    })

    it('refuses a member nobody invited (one who signed in another way)', async () => {
      const selfMade = await seedUser({ email: 'Super.Admin@Example.com', role: 'admin' })
      const r = await changeEmail(selfMade, 'someone@example.com')
      expect(r.status).toBe(400)
      expect(r.body.error).toMatch(/pending invite/i)
      await expectUntouched(selfMade, 'Super.Admin@Example.com')
    })

    it('refuses a deactivated member', async () => {
      const gone = await seedPending('gone@exmaple.com', { deactivatedAt: '2026-01-01 00:00:00' })
      const r = await changeEmail(gone, 'gone@example.com')
      expect(r.status).toBe(400)
      expect(r.body.error).toMatch(/deactivated/i)
      await expectUntouched(gone, 'gone@exmaple.com')
    })

    it('refuses the caller themselves', async () => {
      const r = await changeEmail(adminId, 'admin2@example.com')
      expect(r.status).toBe(400)
      expect(r.body.error).toMatch(/your own/i)
      await expectUntouched(adminId, 'admin@example.com')
    })

    it('refuses a non-admin caller', async () => {
      const memberId = await seedUser({ role: 'member', email: 'member@example.com' })
      const memberCookie = `session=${await seedSession(memberId)}`
      const r = await changeEmail(pendingId, 'jane@example.com', { cookie: memberCookie })
      expect(r.status).toBe(403)
      await expectUntouched(pendingId, 'jane@exmaple.com')
    })

    it('refuses a non-Owner changing a pending Owner', async () => {
      const pendingOwner = await seedPending('boss@exmaple.com', { role: 'owner' })
      const r = await changeEmail(pendingOwner, 'boss@example.com')
      expect(r.status).toBe(403)
      expect(r.body.error).toMatch(/owner/i)
      await expectUntouched(pendingOwner, 'boss@exmaple.com')
    })

    it('returns 404 for an unknown member', async () => {
      const r = await changeEmail('no-such-member', 'jane@example.com')
      expect(r.status).toBe(404)
      expect(sendMagicLink).not.toHaveBeenCalled()
    })
  })

  describe('races', () => {
    it('maps a uniqueness clash at write time to the in-use message', async () => {
      // Another change lands between this request's check and its write: the
      // trigger inserts a member with the new address just before the update.
      await env.DB.exec(
        "CREATE TRIGGER race_in BEFORE UPDATE OF email ON users BEGIN INSERT INTO users (id, email) VALUES ('racer', NEW.email); END",
      )
      try {
        expect(await changeEmail(pendingId, 'jane@example.com')).toEqual({ status: 409, body: { error: IN_USE } })
      } finally {
        await env.DB.exec('DROP TRIGGER race_in')
      }
      expect((await memberRow(pendingId)).email).toBe('jane@exmaple.com')
      expect(await eventsFor(pendingId, 'email_changed')).toHaveLength(0)
      expect(sendMagicLink).not.toHaveBeenCalled()
    })

    it('lets exactly one of two concurrent changes to the same address through', async () => {
      const other = await seedPending('pat@exmaple.com')
      const results = await Promise.all([
        changeEmail(pendingId, 'shared@example.com'),
        changeEmail(other, 'shared@example.com'),
      ])
      expect(results.map(r => r.status).sort()).toEqual([200, 409])
      expect(results.find(r => r.status === 409)!.body).toEqual({ error: IN_USE })
      const holders = (await getDb(env.DB).select().from(users).all()).filter(u => u.email === 'shared@example.com')
      expect(holders).toHaveLength(1)
      expect(sendMagicLink).toHaveBeenCalledTimes(1)
    })
  })

  describe('history', () => {
    it('shows the change, old and new address, and who made it in Member history', async () => {
      await changeEmail(pendingId, 'jane@example.com')
      const res = await app.request(`/api/admin/members/${pendingId}/auth-events`, { headers: { Cookie: adminCookie } }, env)
      const body = await res.json() as { events: Array<Record<string, unknown>> }
      const changed = body.events.find(e => e.event === 'email_changed')
      expect(changed).toMatchObject({ email: 'jane@example.com', reason: 'jane@exmaple.com', actorName: 'Ada Admin' })
    })

    it("shows the same entry in the member's own Account history once they sign in", async () => {
      await changeEmail(pendingId, 'jane@example.com')
      const cookie = `session=${await seedSession(pendingId)}`
      const res = await app.request('/api/users/me/auth-events', { headers: { Cookie: cookie } }, env)
      const body = await res.json() as { events: Array<Record<string, unknown>> }
      const changed = body.events.find(e => e.event === 'email_changed')
      expect(changed).toMatchObject({ email: 'jane@example.com', reason: 'jane@exmaple.com', actorName: 'Ada Admin' })
    })

    it("falls back to the admin's address when they have no name, and to null once they are gone", async () => {
      await getDb(env.DB).update(users).set({ name: '' }).where(eq(users.id, adminId))
      await changeEmail(pendingId, 'jane@example.com')
      const read = async () => {
        const res = await app.request(`/api/admin/members/${pendingId}/auth-events`, { headers: { Cookie: adminCookie } }, env)
        const body = await res.json() as { events: Array<Record<string, unknown>> }
        return body.events.find(e => e.event === 'email_changed')!
      }
      expect((await read()).actorName).toBe('admin@example.com')
      await getDb(env.DB).update(authEvents).set({ actorId: 'deleted-admin' }).where(eq(authEvents.userId, pendingId))
      expect((await read()).actorName).toBeNull()
    })
  })
})
