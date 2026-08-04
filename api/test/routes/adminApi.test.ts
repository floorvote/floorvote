import { describe, it, expect, vi, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { app } from '../../src/index'
import { resetDb, applyMigrations, seedUser, seedSession, seedBill, seedMagicLink, seedRole, seedUserRole, seedAuthEvent } from '../helpers'
import { getDb } from '../../src/db/client'
import { users, sessions, magicLinks, associationConfig, bills, comments, memberVotes, notes, feedEvents, roles, userRoles, authEvents } from '../../src/db/schema'
import { eq } from 'drizzle-orm'

vi.mock('../../src/lib/centralFetch', () => ({
  centralFetch: vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }),
}))

vi.mock('../../src/lib/email', () => ({
  sendMagicLink: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../src/cron/sync', () => ({
  registerWithCentral: vi.fn().mockResolvedValue(undefined),
}))

describe('Admin Members API', () => {
  let adminId: string
  let adminCookie: string
  let memberId: string
  let memberCookie: string

  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    adminId = await seedUser({ role: 'admin', email: 'admin@example.com', name: 'Admin User' })
    const adminToken = await seedSession(adminId)
    adminCookie = `session=${adminToken}`
    memberId = await seedUser({ role: 'member', email: 'member@example.com', name: 'Member User' })
    const memberToken = await seedSession(memberId)
    memberCookie = `session=${memberToken}`
  })

  // GET /admin/members
  describe('GET /admin/members', () => {
    it('returns 401 without a session cookie', async () => {
      const res = await app.request('/api/admin/members', {}, env)
      expect(res.status).toBe(401)
    })

    it('returns 403 for a member user', async () => {
      const res = await app.request(
        '/api/admin/members',
        { headers: { Cookie: memberCookie } },
        env,
      )
      expect(res.status).toBe(403)
    })

    it('returns 200 with a list of all users for admin', async () => {
      const res = await app.request(
        '/api/admin/members',
        { headers: { Cookie: adminCookie } },
        env,
      )
      expect(res.status).toBe(200)
      const body = await res.json() as { id: string; email: string; role: string; deactivatedAt: string | null; hasLoggedIn: boolean }[]
      expect(Array.isArray(body)).toBe(true)
      expect(body.length).toBe(2)
      const emails = body.map((u) => u.email)
      expect(emails).toContain('admin@example.com')
      expect(emails).toContain('member@example.com')
      const admin = body.find((u) => u.email === 'admin@example.com')!
      expect(admin).toHaveProperty('id')
      expect(admin).toHaveProperty('name')
      expect(admin).toHaveProperty('role')
      expect(admin).toHaveProperty('createdAt')
      expect(admin).toHaveProperty('lastActive')
      expect(admin).toHaveProperty('deactivatedAt')
      expect(admin.deactivatedAt).toBeNull()
      expect(admin.hasLoggedIn).toBe(false)
    })

    it('returns users ordered by createdAt desc', async () => {
      const res = await app.request(
        '/api/admin/members',
        { headers: { Cookie: adminCookie } },
        env,
      )
      expect(res.status).toBe(200)
      const body = await res.json() as { createdAt: string }[]
      for (let i = 1; i < body.length; i++) {
        expect(body[i - 1].createdAt >= body[i].createdAt).toBe(true)
      }
    })

    it('returns hasLoggedIn: false for a user with no used magic links', async () => {
      const invitedId = await seedUser({ email: 'invited@example.com', name: 'Invited' })
      await seedMagicLink(invitedId) // valid but not used

      const res = await app.request(
        '/api/admin/members',
        { headers: { Cookie: adminCookie } },
        env,
      )
      expect(res.status).toBe(200)
      const body = await res.json() as { id: string; email: string; hasLoggedIn: boolean }[]
      const invited = body.find((u) => u.email === 'invited@example.com')!
      expect(invited).toBeDefined()
      expect(invited.hasLoggedIn).toBe(false)
    })

    it('returns hasLoggedIn: true for a user with a used magic link', async () => {
      const userId = await seedUser({ email: 'active@example.com', name: 'Active' })
      await seedMagicLink(userId, { used: true })

      const res = await app.request(
        '/api/admin/members',
        { headers: { Cookie: adminCookie } },
        env,
      )
      expect(res.status).toBe(200)
      const body = await res.json() as { id: string; email: string; hasLoggedIn: boolean }[]
      const active = body.find((u) => u.email === 'active@example.com')!
      expect(active).toBeDefined()
      expect(active.hasLoggedIn).toBe(true)
    })

    it('includes roles for each member', async () => {
      const roleId = await seedRole('Elections Committee')
      await seedUserRole(memberId, roleId)

      const res = await app.request('/api/admin/members', {
        headers: { cookie: adminCookie },
      }, env)
      expect(res.status).toBe(200)
      const members = await res.json() as Array<{ id: string; roles: { id: string; name: string }[] }>

      const member = members.find(m => m.id === memberId)!
      expect(member.roles).toHaveLength(1)
      expect(member.roles[0]).toEqual({ id: roleId, name: 'Elections Committee' })

      const admin = members.find(m => m.id === adminId)!
      expect(admin.roles).toEqual([])
    })
  })

  // POST /admin/members/:id/resend-invite
  describe('POST /admin/members/:id/resend-invite', () => {
    it('returns 403 for a member user', async () => {
      const res = await app.request(
        `/api/admin/members/${memberId}/resend-invite`,
        { method: 'POST', headers: { Cookie: memberCookie } },
        env,
      )
      expect(res.status).toBe(403)
    })

    it('returns 404 for a nonexistent user', async () => {
      const res = await app.request(
        '/api/admin/members/nonexistent-id/resend-invite',
        { method: 'POST', headers: { Cookie: adminCookie } },
        env,
      )
      expect(res.status).toBe(404)
      const body = await res.json() as { error: string }
      expect(body.error).toBe('User not found')
    })

    it('returns 400 for a deactivated user', async () => {
      const db = getDb(env.DB)
      await db.update(users).set({ deactivatedAt: new Date().toISOString() }).where(eq(users.id, memberId))

      const res = await app.request(
        `/api/admin/members/${memberId}/resend-invite`,
        { method: 'POST', headers: { Cookie: adminCookie } },
        env,
      )
      expect(res.status).toBe(400)
      const body = await res.json() as { error: string }
      expect(body.error).toBe('Cannot resend invite to a deactivated user')
    })

    it('creates a new magic link and returns 200', async () => {
      const db = getDb(env.DB)
      const res = await app.request(
        `/api/admin/members/${memberId}/resend-invite`,
        { method: 'POST', headers: { Cookie: adminCookie } },
        env,
      )
      expect(res.status).toBe(200)
      const body = await res.json() as { ok: boolean }
      expect(body.ok).toBe(true)

      const links = await db.select().from(magicLinks).where(eq(magicLinks.userId, memberId)).all()
      expect(links.length).toBeGreaterThanOrEqual(1)
      const newest = links.sort((a, b) => b.expiresAt.localeCompare(a.expiresAt))[0]
      expect(new Date(newest.expiresAt).getTime() - Date.now()).toBeGreaterThan(6 * 24 * 60 * 60 * 1000)
    })
  })

  // POST /admin/members/:id/resend-login
  describe('POST /admin/members/:id/resend-login', () => {
    it('returns 403 for a member user', async () => {
      const res = await app.request(
        `/api/admin/members/${memberId}/resend-login`,
        { method: 'POST', headers: { Cookie: memberCookie } },
        env,
      )
      expect(res.status).toBe(403)
    })

    it('returns 404 for a nonexistent user', async () => {
      const res = await app.request(
        '/api/admin/members/nonexistent-id/resend-login',
        { method: 'POST', headers: { Cookie: adminCookie } },
        env,
      )
      expect(res.status).toBe(404)
      const body = await res.json() as { error: string }
      expect(body.error).toBe('User not found')
    })

    it('returns 400 for a deactivated user', async () => {
      const db = getDb(env.DB)
      await db.update(users).set({ deactivatedAt: new Date().toISOString() }).where(eq(users.id, memberId))

      const res = await app.request(
        `/api/admin/members/${memberId}/resend-login`,
        { method: 'POST', headers: { Cookie: adminCookie } },
        env,
      )
      expect(res.status).toBe(400)
      const body = await res.json() as { error: string }
      expect(body.error).toBe('Cannot resend a login link to a deactivated user')
    })

    it('creates a short-lived (login TTL) magic link and returns 200', async () => {
      const db = getDb(env.DB)
      const res = await app.request(
        `/api/admin/members/${memberId}/resend-login`,
        { method: 'POST', headers: { Cookie: adminCookie } },
        env,
      )
      expect(res.status).toBe(200)
      const body = await res.json() as { ok: boolean }
      expect(body.ok).toBe(true)

      const links = await db.select().from(magicLinks).where(eq(magicLinks.userId, memberId)).all()
      expect(links.length).toBeGreaterThanOrEqual(1)
      const newest = links.sort((a, b) => b.expiresAt.localeCompare(a.expiresAt))[0]
      const ttlMs = new Date(newest.expiresAt).getTime() - Date.now()
      // Login link, not an invite: minutes-long TTL, nowhere near the 7-day invite window.
      expect(ttlMs).toBeGreaterThan(30 * 60 * 1000)
      expect(ttlMs).toBeLessThan(6 * 24 * 60 * 60 * 1000)
    })

    it('does not require a Turnstile token (unlike the public /auth/magic-link)', async () => {
      // Regression: the admin action used to POST the public, Turnstile-gated
      // /auth/magic-link with no token, yielding 403 "Verification required."
      // on tenants with TURNSTILE_SECRET_KEY set.
      const res = await app.request(
        `/api/admin/members/${memberId}/resend-login`,
        { method: 'POST', headers: { Cookie: adminCookie } },
        { ...env, TURNSTILE_SECRET_KEY: 'test-secret' },
      )
      expect(res.status).toBe(200)
    })
  })

  // PATCH /admin/members/:id
  describe('PATCH /admin/members/:id', () => {
    it('returns 403 for a member user', async () => {
      const res = await app.request(
        `/api/admin/members/${memberId}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Cookie: memberCookie },
          body: JSON.stringify({ role: 'admin' }),
        },
        env,
      )
      expect(res.status).toBe(403)
    })

    it('allows an admin to demote themselves', async () => {
      const res = await app.request(
        `/api/admin/members/${adminId}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
          body: JSON.stringify({ role: 'member' }),
        },
        env,
      )
      expect(res.status).toBe(200)
    })

    it('returns 404 for unknown user id', async () => {
      const res = await app.request(
        '/api/admin/members/nonexistent-id',
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
          body: JSON.stringify({ role: 'admin' }),
        },
        env,
      )
      expect(res.status).toBe(404)
    })

    it('updates role to admin', async () => {
      const res = await app.request(
        `/api/admin/members/${memberId}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
          body: JSON.stringify({ role: 'admin' }),
        },
        env,
      )
      expect(res.status).toBe(200)
      const body = await res.json() as { ok: boolean }
      expect(body.ok).toBe(true)

      const db = getDb(env.DB)
      const user = await db.select().from(users).where(eq(users.id, memberId)).get()
      expect(user!.role).toBe('admin')
    })

    it('deactivates a user', async () => {
      const res = await app.request(
        `/api/admin/members/${memberId}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
          body: JSON.stringify({ deactivated: true }),
        },
        env,
      )
      expect(res.status).toBe(200)

      const db = getDb(env.DB)
      const user = await db.select().from(users).where(eq(users.id, memberId)).get()
      expect(user!.deactivatedAt).not.toBeNull()
    })

    it('reactivates a deactivated user', async () => {
      const db = getDb(env.DB)
      await db.update(users).set({ deactivatedAt: new Date().toISOString() }).where(eq(users.id, memberId))

      const res = await app.request(
        `/api/admin/members/${memberId}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
          body: JSON.stringify({ deactivated: false }),
        },
        env,
      )
      expect(res.status).toBe(200)

      const user = await db.select().from(users).where(eq(users.id, memberId)).get()
      expect(user!.deactivatedAt).toBeNull()
    })

    it('deactivated user gets 401 on subsequent requests (sessions invalidated)', async () => {
      // Deactivate the member — this also deletes their sessions immediately
      await app.request(
        `/api/admin/members/${memberId}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
          body: JSON.stringify({ deactivated: true }),
        },
        env,
      )

      // Member tries to use their old session cookie — session no longer exists, so 401
      const res = await app.request(
        '/api/admin/members',
        { headers: { Cookie: memberCookie } },
        env,
      )
      expect(res.status).toBe(401)
    })

    it('invalidates sessions on role change (SEC-I3)', async () => {
      // Seed a second session for the member so we can test it is revoked after role change
      const memberToken2 = await seedSession(memberId)

      // Admin changes the member's role
      await app.request(
        `/api/admin/members/${memberId}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
          body: JSON.stringify({ role: 'admin' }),
        },
        env,
      )

      // Old session should be invalidated — any authenticated route returns 401
      const res = await app.request(
        '/api/admin/members',
        { headers: { Cookie: `session=${memberToken2}` } },
        env,
      )
      expect(res.status).toBe(401)
    })

    it('blocks demoting the last active owner even when a deactivated owner exists', async () => {
      const ownerId = await seedUser({ role: 'owner', email: 'owner@example.com', name: 'Owner User' })
      const ownerToken = await seedSession(ownerId)
      const ownerCookie = `session=${ownerToken}`
      await seedUser({
        role: 'owner',
        email: 'owner2@example.com',
        name: 'Deactivated Owner',
        deactivatedAt: new Date().toISOString(),
      })

      const res = await app.request(
        `/api/admin/members/${ownerId}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
          body: JSON.stringify({ role: 'admin' }),
        },
        env,
      )
      expect(res.status).toBe(400)
      const body = await res.json() as { error: string }
      expect(body.error).toBe('Cannot demote the last owner')

      const db = getDb(env.DB)
      const user = await db.select().from(users).where(eq(users.id, ownerId)).get()
      expect(user!.role).toBe('owner')
    })

    it('blocks a non-owner admin from deactivating an owner', async () => {
      const ownerId = await seedUser({ role: 'owner', email: 'owner@example.com', name: 'Owner User' })

      const res = await app.request(
        `/api/admin/members/${ownerId}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
          body: JSON.stringify({ deactivated: true }),
        },
        env,
      )
      expect(res.status).toBe(403)

      const db = getDb(env.DB)
      const user = await db.select().from(users).where(eq(users.id, ownerId)).get()
      expect(user!.deactivatedAt).toBeNull()
    })

    it('blocks deactivating the last active owner (self via admin PATCH)', async () => {
      const ownerId = await seedUser({ role: 'owner', email: 'owner@example.com', name: 'Owner User' })
      const ownerToken = await seedSession(ownerId)

      const res = await app.request(
        `/api/admin/members/${ownerId}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Cookie: `session=${ownerToken}` },
          body: JSON.stringify({ deactivated: true }),
        },
        env,
      )
      expect(res.status).toBe(400)
      const body = await res.json() as { error: string }
      expect(body.error).toBe('Cannot deactivate the last owner')

      const db = getDb(env.DB)
      const user = await db.select().from(users).where(eq(users.id, ownerId)).get()
      expect(user!.deactivatedAt).toBeNull()
    })

    it('lets an owner deactivate another owner when a second active owner remains', async () => {
      const ownerAId = await seedUser({ role: 'owner', email: 'ownera@example.com', name: 'Owner A' })
      const ownerAToken = await seedSession(ownerAId)
      const ownerBId = await seedUser({ role: 'owner', email: 'ownerb@example.com', name: 'Owner B' })

      const res = await app.request(
        `/api/admin/members/${ownerBId}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Cookie: `session=${ownerAToken}` },
          body: JSON.stringify({ deactivated: true }),
        },
        env,
      )
      expect(res.status).toBe(200)

      const db = getDb(env.DB)
      const user = await db.select().from(users).where(eq(users.id, ownerBId)).get()
      expect(user!.deactivatedAt).not.toBeNull()
    })

    it('does not last-owner-block acting on an already-deactivated owner (deactivate)', async () => {
      const ownerId = await seedUser({ role: 'owner', email: 'owner@example.com', name: 'Owner' })
      const ownerToken = await seedSession(ownerId)
      const exOwnerId = await seedUser({
        role: 'owner', email: 'exowner@example.com', name: 'Ex Owner',
        deactivatedAt: new Date().toISOString(),
      })

      // Sole ACTIVE owner acts on a DEACTIVATED owner — not the last active one, so allowed.
      const res = await app.request(
        `/api/admin/members/${exOwnerId}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Cookie: `session=${ownerToken}` },
          body: JSON.stringify({ deactivated: true }),
        },
        env,
      )
      expect(res.status).toBe(200)
    })

    it('does not last-owner-block demoting an already-deactivated owner', async () => {
      const ownerId = await seedUser({ role: 'owner', email: 'owner@example.com', name: 'Owner' })
      const ownerToken = await seedSession(ownerId)
      const exOwnerId = await seedUser({
        role: 'owner', email: 'exowner@example.com', name: 'Ex Owner',
        deactivatedAt: new Date().toISOString(),
      })

      const res = await app.request(
        `/api/admin/members/${exOwnerId}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Cookie: `session=${ownerToken}` },
          body: JSON.stringify({ role: 'admin' }),
        },
        env,
      )
      expect(res.status).toBe(200)

      const db = getDb(env.DB)
      const user = await db.select().from(users).where(eq(users.id, exOwnerId)).get()
      expect(user!.role).toBe('admin')
    })
  })

  // DELETE /admin/members/:id
  describe('DELETE /admin/members/:id', () => {
    beforeEach(async () => {
      // Hard delete is gated behind account_deletion_enabled; enable it so these
      // cascade-behavior tests reach the delete logic. Gate behavior itself is
      // covered in accountDelete.gate.test.ts.
      await getDb(env.DB).insert(associationConfig).values({ key: 'account_deletion_enabled', value: 'true' })
    })

    it('returns 403 for a member user', async () => {
      const res = await app.request(
        `/api/admin/members/${adminId}`,
        { method: 'DELETE', headers: { Cookie: memberCookie } },
        env,
      )
      expect(res.status).toBe(403)
    })

    it('returns 400 when targeting self', async () => {
      const res = await app.request(
        `/api/admin/members/${adminId}`,
        { method: 'DELETE', headers: { Cookie: adminCookie } },
        env,
      )
      expect(res.status).toBe(400)
      const body = await res.json() as { error: string }
      expect(body.error).toBe('Cannot delete your own account')
    })

    it('returns 404 for unknown user id', async () => {
      const res = await app.request(
        '/api/admin/members/nonexistent-id',
        { method: 'DELETE', headers: { Cookie: adminCookie } },
        env,
      )
      expect(res.status).toBe(404)
    })

    it('blocks a non-owner admin from deleting an owner', async () => {
      const ownerId = await seedUser({ role: 'owner', email: 'owner@example.com', name: 'Owner User' })

      const res = await app.request(
        `/api/admin/members/${ownerId}`,
        { method: 'DELETE', headers: { Cookie: adminCookie } },
        env,
      )
      expect(res.status).toBe(403)

      const db = getDb(env.DB)
      const user = await db.select().from(users).where(eq(users.id, ownerId)).get()
      expect(user).toBeDefined()
    })

    it('lets an owner delete another owner when a second active owner remains', async () => {
      const ownerAId = await seedUser({ role: 'owner', email: 'ownera@example.com', name: 'Owner A' })
      const ownerAToken = await seedSession(ownerAId)
      const ownerBId = await seedUser({ role: 'owner', email: 'ownerb@example.com', name: 'Owner B' })

      const res = await app.request(
        `/api/admin/members/${ownerBId}`,
        { method: 'DELETE', headers: { Cookie: `session=${ownerAToken}` } },
        env,
      )
      expect(res.status).toBe(200)

      const db = getDb(env.DB)
      const user = await db.select().from(users).where(eq(users.id, ownerBId)).get()
      expect(user).toBeUndefined()
    })

    it('does not last-owner-block deleting an already-deactivated owner', async () => {
      const ownerId = await seedUser({ role: 'owner', email: 'owner@example.com', name: 'Owner' })
      const ownerToken = await seedSession(ownerId)
      const exOwnerId = await seedUser({
        role: 'owner', email: 'exowner@example.com', name: 'Ex Owner',
        deactivatedAt: new Date().toISOString(),
      })

      // Sole ACTIVE owner deletes a DEACTIVATED ex-owner — not the last active one, so allowed.
      const res = await app.request(
        `/api/admin/members/${exOwnerId}`,
        { method: 'DELETE', headers: { Cookie: `session=${ownerToken}` } },
        env,
      )
      expect(res.status).toBe(200)

      const db = getDb(env.DB)
      const user = await db.select().from(users).where(eq(users.id, exOwnerId)).get()
      expect(user).toBeUndefined()
    })

    it('deletes user, their sessions, and their magic links', async () => {
      const db = getDb(env.DB)
      await db.insert(magicLinks).values({
        id: crypto.randomUUID(),
        userId: memberId,
        tokenHash: 'fakehash123',
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      })

      const res = await app.request(
        `/api/admin/members/${memberId}`,
        { method: 'DELETE', headers: { Cookie: adminCookie } },
        env,
      )
      expect(res.status).toBe(200)
      const body = await res.json() as { ok: boolean }
      expect(body.ok).toBe(true)

      const user = await db.select().from(users).where(eq(users.id, memberId)).get()
      expect(user).toBeUndefined()

      const remainingSessions = await db.select().from(sessions).where(eq(sessions.userId, memberId)).all()
      expect(remainingSessions.length).toBe(0)

      const remainingLinks = await db.select().from(magicLinks).where(eq(magicLinks.userId, memberId)).all()
      expect(remainingLinks.length).toBe(0)
    })

    it('cascade-deletes all user content (ARCH-I1)', async () => {
      const db = getDb(env.DB)
      const billId = await seedBill()

      await db.insert(comments).values({
        id: crypto.randomUUID(),
        billId,
        userId: memberId,
        content: 'Test.',
        createdAt: new Date().toISOString(),
      })
      await db.insert(memberVotes).values({
        id: crypto.randomUUID(),
        billId,
        userId: memberId,
        position: 'support',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      await db.insert(notes).values({
        id: crypto.randomUUID(),
        billId,
        userId: memberId,
        content: 'My note.',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      await db.insert(feedEvents).values({
        id: crypto.randomUUID(),
        type: 'comment_added',
        billId,
        userId: memberId,
        metadata: JSON.stringify({}),
        createdAt: new Date().toISOString(),
      })

      const res = await app.request(
        `/api/admin/members/${memberId}`,
        { method: 'DELETE', headers: { Cookie: adminCookie } },
        env,
      )
      expect(res.status).toBe(200)

      const remainingComments = await db.select().from(comments).where(eq(comments.userId, memberId)).all()
      expect(remainingComments.length).toBe(0)

      const remainingVotes = await db.select().from(memberVotes).where(eq(memberVotes.userId, memberId)).all()
      expect(remainingVotes.length).toBe(0)

      const remainingNotes = await db.select().from(notes).where(eq(notes.userId, memberId)).all()
      expect(remainingNotes.length).toBe(0)

      const remainingFeedEvents = await db.select().from(feedEvents).where(eq(feedEvents.userId, memberId)).all()
      expect(remainingFeedEvents.length).toBe(0)
    })
  })
})

describe('auth event logging — admin invite', () => {
  let adminCookie: string

  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    const adminId = await seedUser({ role: 'admin', email: 'admin@example.com', name: 'Admin User' })
    const adminToken = await seedSession(adminId)
    adminCookie = `session=${adminToken}`
  })

  it('records link_requested (invite) when resending an invite', async () => {
    const db = getDb(env.DB)
    const targetId = await seedUser({ role: 'member', email: 'target@b.com', name: 'Target' })
    const res = await app.request(
      `/api/admin/members/${targetId}/resend-invite`,
      {
        method: 'POST',
        headers: { Cookie: adminCookie },
      },
      env,
    )
    expect(res.status).toBe(200)
    const rows = await db.select().from(authEvents).all()
    expect(rows.some(r => r.event === 'link_requested' && r.linkType === 'invite' && r.email === 'target@b.com')).toBe(true)
  })

  it('records link_requested (login) when resending a login link', async () => {
    const db = getDb(env.DB)
    const targetId = await seedUser({ role: 'member', email: 'login-target@b.com', name: 'Login Target' })
    const res = await app.request(
      `/api/admin/members/${targetId}/resend-login`,
      {
        method: 'POST',
        headers: { Cookie: adminCookie },
      },
      env,
    )
    expect(res.status).toBe(200)
    const rows = await db.select().from(authEvents).all()
    expect(rows.some(r => r.event === 'link_requested' && r.linkType === 'login' && r.email === 'login-target@b.com')).toBe(true)
  })
})

describe('Admin Config API', () => {
  let adminId: string
  let adminCookie: string
  let memberCookie: string

  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    const db = getDb(env.DB)
    await db.delete(associationConfig)
    adminId = await seedUser({ role: 'admin', email: 'admin@example.com', name: 'Admin User' })
    const adminToken = await seedSession(adminId)
    adminCookie = `session=${adminToken}`
    const memberId = await seedUser({ role: 'member', email: 'member@example.com', name: 'Member' })
    const memberToken = await seedSession(memberId)
    memberCookie = `session=${memberToken}`
  })

  describe('GET /admin/config', () => {
    it('returns 403 for a member', async () => {
      const res = await app.request('/api/admin/config', { headers: { Cookie: memberCookie } }, env)
      expect(res.status).toBe(403)
    })

    it('returns 200 with an empty object when no config exists', async () => {
      const res = await app.request('/api/admin/config', { headers: { Cookie: adminCookie } }, env)
      expect(res.status).toBe(200)
      const body = await res.json() as Record<string, unknown>
      expect(typeof body).toBe('object')
    })

    it('returns parsed config values as JSON', async () => {
      const db = getDb(env.DB)
      await db.insert(associationConfig).values({ key: 'association_name', value: JSON.stringify('My Association') })
      await db.insert(associationConfig).values({ key: 'sync_frequency', value: JSON.stringify('daily') })

      const res = await app.request('/api/admin/config', { headers: { Cookie: adminCookie } }, env)
      expect(res.status).toBe(200)
      const body = await res.json() as Record<string, unknown>
      expect(body.association_name).toBe('My Association')
      expect(body).not.toHaveProperty('position_vocabulary')
      expect(body.sync_frequency).toBe('daily')
    })

    it('omits keys not in ALLOWED_CONFIG_KEYS', async () => {
      const db = getDb(env.DB)
      await db.insert(associationConfig).values({ key: 'state', value: JSON.stringify('CA') })
      await db.insert(associationConfig).values({ key: 'reaction_emojis', value: JSON.stringify(['👍']) })

      const res = await app.request('/api/admin/config', { headers: { Cookie: adminCookie } }, env)
      expect(res.status).toBe(200)
      const body = await res.json() as Record<string, unknown>
      expect(body).not.toHaveProperty('state')
      expect(body).not.toHaveProperty('reaction_emojis')
    })
  })

  describe('PUT /admin/config', () => {
    it('returns 403 for a member', async () => {
      const res = await app.request(
        '/api/admin/config',
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Cookie: memberCookie },
          body: JSON.stringify({ association_name: 'Test' }),
        },
        env,
      )
      expect(res.status).toBe(403)
    })

    it('returns 400 for unknown keys', async () => {
      const res = await app.request(
        '/api/admin/config',
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
          body: JSON.stringify({ unknown_key: 'value' }),
        },
        env,
      )
      expect(res.status).toBe(400)
      const body = await res.json() as { error: string }
      expect(body.error).toContain('unknown_key')
    })

    it('inserts new config values', async () => {
      const res = await app.request(
        '/api/admin/config',
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
          body: JSON.stringify({
            association_name: 'My Org',
            sync_frequency: 'daily',
          }),
        },
        env,
      )
      expect(res.status).toBe(200)
      const body = await res.json() as { ok: boolean }
      expect(body.ok).toBe(true)

      const db = getDb(env.DB)
      const nameRow = await db.select().from(associationConfig).where(eq(associationConfig.key, 'association_name')).get()
      expect(JSON.parse(nameRow!.value)).toBe('My Org')
      const freqRow = await db.select().from(associationConfig).where(eq(associationConfig.key, 'sync_frequency')).get()
      expect(JSON.parse(freqRow!.value)).toBe('daily')
    })

    it('persists new_match_min_relevance and reads it back', async () => {
      const putRes = await app.request(
        '/api/admin/config',
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
          body: JSON.stringify({ new_match_min_relevance: 40 }),
        },
        env,
      )
      expect(putRes.status).toBe(200)

      const getRes = await app.request('/api/admin/config', { headers: { Cookie: adminCookie } }, env)
      const body = await getRes.json() as { new_match_min_relevance?: number }
      expect(body.new_match_min_relevance).toBe(40)

      const { getNewMatchMinRelevance } = await import('../../src/lib/newMatch')
      expect(await getNewMatchMinRelevance(getDb(env.DB))).toBe(40)
    })

    it('upserts existing config values', async () => {
      const db = getDb(env.DB)
      await db.insert(associationConfig).values({ key: 'association_name', value: JSON.stringify('Old Name') })

      const res = await app.request(
        '/api/admin/config',
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
          body: JSON.stringify({ association_name: 'New Name' }),
        },
        env,
      )
      expect(res.status).toBe(200)
      const nameRow = await db.select().from(associationConfig).where(eq(associationConfig.key, 'association_name')).get()
      expect(JSON.parse(nameRow!.value)).toBe('New Name')
    })

    it('accepts a valid modules object and stores it as JSON', async () => {
      const res = await app.request(
        '/api/admin/config',
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
          body: JSON.stringify({ modules: { 'waiting-for-vote': true } }),
        },
        env,
      )
      expect(res.status).toBe(200)

      const db = getDb(env.DB)
      const row = await db
        .select()
        .from(associationConfig)
        .where(eq(associationConfig.key, 'modules'))
        .get()
      expect(row).toBeDefined()
      expect(JSON.parse(row!.value)).toEqual({ 'waiting-for-vote': true })
    })

    it('returns 400 when modules is not an object', async () => {
      const res = await app.request(
        '/api/admin/config',
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
          body: JSON.stringify({ modules: 'nope' }),
        },
        env,
      )
      expect(res.status).toBe(400)
      const body = await res.json() as { error: string }
      expect(body.error).toMatch(/modules/i)
    })

    it('returns 400 when modules contains a non-boolean value', async () => {
      const res = await app.request(
        '/api/admin/config',
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
          body: JSON.stringify({ modules: { 'waiting-for-vote': 'yes' } }),
        },
        env,
      )
      expect(res.status).toBe(400)
      const body = await res.json() as { error: string }
      expect(body.error).toMatch(/modules/i)
    })

    it('returns modules in GET /admin/config after a write', async () => {
      await app.request(
        '/api/admin/config',
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
          body: JSON.stringify({ modules: { 'waiting-for-vote': true } }),
        },
        env,
      )
      const res = await app.request('/api/admin/config', { headers: { Cookie: adminCookie } }, env)
      expect(res.status).toBe(200)
      const body = await res.json() as Record<string, unknown>
      expect(body.modules).toEqual({ 'waiting-for-vote': true })
    })
  })

  describe('GET /config (public)', () => {
    it('returns 401 without auth', async () => {
      const res = await app.request('/api/config', {}, env)
      expect(res.status).toBe(401)
    })

    it('returns defaults when no config rows exist', async () => {
      const res = await app.request('/api/config', { headers: { Cookie: memberCookie } }, env)
      expect(res.status).toBe(200)
      const body = await res.json() as { associationName: string; positionVocabulary: string[]; state: string }
      expect(body.associationName).toBe('FloorVote')
      expect(body.positionVocabulary).toEqual(['Support', 'Oppose', 'Amend', 'Monitor', 'No Position'])
      expect(body).not.toHaveProperty('reactionEmojis')
      expect(body.state).toBe('')
    })

    it('returns configured values when they exist', async () => {
      const db = getDb(env.DB)
      await db.insert(associationConfig).values({ key: 'association_name', value: JSON.stringify('Custom Org') })

      const res = await app.request('/api/config', { headers: { Cookie: memberCookie } }, env)
      expect(res.status).toBe(200)
      const body = await res.json() as { associationName: string; positionVocabulary: string[]; state: string }
      expect(body.associationName).toBe('Custom Org')
      expect(body.positionVocabulary).toEqual(['Support', 'Oppose', 'Amend', 'Monitor', 'No Position'])
      expect(body.state).toBe('')
    })
  })
})

describe('POST /admin/refresh-metadata', () => {
  let adminCookie: string

  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    const adminId = await seedUser({ role: 'admin', email: 'admin@example.com', name: 'Admin User' })
    const adminToken = await seedSession(adminId)
    adminCookie = `session=${adminToken}`
  })

  it('returns 503 when queue not configured', async () => {
    const res = await app.request('/api/admin/refresh-metadata', {
      method: 'POST',
      headers: { Cookie: adminCookie },
    }, { ...env, BILL_QUEUE: undefined })
    expect(res.status).toBe(503)
  })

  it('queues all bills with external_id using metadataOnly=true (never triggers AI)', async () => {
    await seedBill({ externalId: 'ocd-bill/100' })
    await seedBill({ externalId: 'ocd-bill/200' })
    await seedBill({ externalId: undefined })  // should not be queued

    const sent: unknown[] = []
    const mockQueue = {
      sendBatch: vi.fn().mockImplementation((msgs: unknown[]) => {
        sent.push(...msgs)
        return Promise.resolve()
      }),
    }

    const res = await app.request('/api/admin/refresh-metadata', {
      method: 'POST',
      headers: { Cookie: adminCookie },
    }, { ...env, BILL_QUEUE: mockQueue })

    expect(res.status).toBe(200)
    const body = await res.json() as { queued: number }
    expect(body.queued).toBe(2)
    expect(sent).toHaveLength(2)
    const bodies = (sent as Array<{ body: { tenantId: string; billId: string; metadataOnly: boolean; forceMetadata?: boolean; forceAI?: boolean } }>).map(m => m.body)
    // Every message must carry metadataOnly=true so the tenant processor
    // skips text fetch + AI entirely.
    expect(bodies.every(b => b.metadataOnly === true)).toBe(true)
    // No forceMetadata / forceAI — those would cause AI to fire.
    expect(bodies.every(b => b.forceMetadata === undefined)).toBe(true)
    expect(bodies.every(b => b.forceAI === undefined)).toBe(true)
    expect(bodies.map(b => b.billId).sort()).toEqual(['ocd-bill/100', 'ocd-bill/200'].sort())
  })
})

describe('POST /admin/reprocess-bill/:externalId', () => {
  let adminCookie: string

  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    const adminId = await seedUser({ role: 'admin' })
    const adminToken = await seedSession(adminId)
    adminCookie = `session=${adminToken}`
  })

  it('returns 503 when queue not configured', async () => {
    const res = await app.request('/api/admin/reprocess-bill/ocd-bill%2F100', {
      method: 'POST',
      headers: { Cookie: adminCookie },
    }, { ...env, BILL_QUEUE: undefined })
    expect(res.status).toBe(503)
  })

  it('queues the bill and returns { queued: 1 }', async () => {
    let sent: unknown = undefined
    const mockQueue = {
      send: vi.fn().mockImplementation((msg: unknown) => {
        sent = msg
        return Promise.resolve()
      }),
    }
    const res = await app.request('/api/admin/reprocess-bill/ocd-bill%2F100', {
      method: 'POST',
      headers: { Cookie: adminCookie },
    }, { ...env, BILL_QUEUE: mockQueue })
    expect(res.status).toBe(200)
    const body = await res.json() as { queued: number }
    expect(body.queued).toBe(1)
    expect(mockQueue.send).toHaveBeenCalledOnce()
    const msg = sent as { tenantId: string; billId: string; forceAI: boolean }
    expect(msg.billId).toBe('ocd-bill/100')
    expect(msg.forceAI).toBe(true)
  })
})

describe('Preset API', () => {
  let adminCookie: string
  let memberCookie: string

  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    const db = getDb(env.DB)
    await db.delete(associationConfig)
    const adminId = await seedUser({ role: 'admin', email: 'admin@example.com', name: 'Admin User' })
    const adminToken = await seedSession(adminId)
    adminCookie = `session=${adminToken}`
    const memberId = await seedUser({ role: 'member', email: 'member@example.com', name: 'Member' })
    const memberToken = await seedSession(memberId)
    memberCookie = `session=${memberToken}`
  })

  describe('GET /admin/presets', () => {
    it('returns a list containing at least generic and election_officials presets', async () => {
      const res = await app.request('/api/admin/presets', { headers: { Cookie: adminCookie } }, env)
      expect(res.status).toBe(200)
      const body = await res.json() as Array<{ slug: string; name: string }>
      expect(Array.isArray(body)).toBe(true)
      const slugs = body.map((p) => p.slug)
      expect(slugs).toContain('generic')
      expect(slugs).toContain('election_officials')
    })

    it('each preset includes slug, name, description, taxonomy, keywords', async () => {
      const res = await app.request('/api/admin/presets', { headers: { Cookie: adminCookie } }, env)
      const body = await res.json() as Array<Record<string, unknown>>
      for (const preset of body) {
        expect(preset).toHaveProperty('slug')
        expect(preset).toHaveProperty('name')
        expect(preset).toHaveProperty('description')
        expect(Array.isArray(preset.taxonomy)).toBe(true)
        expect(Array.isArray(preset.keywords)).toBe(true)
      }
    })
  })

  describe('POST /admin/apply-preset/:slug', () => {
    it('returns 403 for a member user', async () => {
      const res = await app.request('/api/admin/apply-preset/generic', {
        method: 'POST',
        headers: { Cookie: memberCookie },
      }, env)
      expect(res.status).toBe(403)
    })

    it('returns 404 for an unknown preset slug', async () => {
      const res = await app.request('/api/admin/apply-preset/nonexistent', {
        method: 'POST',
        headers: { Cookie: adminCookie },
      }, env)
      expect(res.status).toBe(404)
      const body = await res.json() as { error: string }
      expect(body.error).toBe('Unknown preset')
    })

    it('writes all expected config keys when applying generic preset', async () => {
      const res = await app.request('/api/admin/apply-preset/generic', {
        method: 'POST',
        headers: { Cookie: adminCookie },
      }, env)
      expect(res.status).toBe(200)
      const body = await res.json() as { ok: boolean; preset: string; queuedForAi: number }
      expect(body.ok).toBe(true)
      expect(body.preset).toBe('generic')
      expect(body.queuedForAi).toBe(0)

      const db = getDb(env.DB)
      const rows = await db.select().from(associationConfig).all()
      const keyMap = new Map(rows.map((r) => [r.key, r.value]))

      expect(keyMap.has('instance_preset')).toBe(true)
      expect(JSON.parse(keyMap.get('instance_preset')!)).toBe('generic')
      expect(keyMap.has('ai_context')).toBe(true)
      expect(keyMap.has('relevance_question')).toBe(true)
      expect(keyMap.has('tag_taxonomy')).toBe(true)
      const taxonomy = JSON.parse(keyMap.get('tag_taxonomy')!)
      expect(Array.isArray(taxonomy)).toBe(true)
      expect(taxonomy.length).toBeGreaterThan(0)
      expect(keyMap.has('keywords')).toBe(true)
    })

    it('writes all expected config keys when applying election_officials preset', async () => {
      const res = await app.request('/api/admin/apply-preset/election_officials', {
        method: 'POST',
        headers: { Cookie: adminCookie },
      }, env)
      expect(res.status).toBe(200)

      const db = getDb(env.DB)
      const rows = await db.select().from(associationConfig).all()
      const keyMap = new Map(rows.map((r) => [r.key, r.value]))

      expect(JSON.parse(keyMap.get('instance_preset')!)).toBe('election_officials')
      const keywords = JSON.parse(keyMap.get('keywords')!)
      expect(Array.isArray(keywords)).toBe(true)
      expect(keywords.length).toBeGreaterThan(0)
    })

    it('overwrites existing config when preset is re-applied', async () => {
      const db = getDb(env.DB)
      await db.insert(associationConfig).values({ key: 'ai_context', value: JSON.stringify('Old context') })

      await app.request('/api/admin/apply-preset/generic', {
        method: 'POST',
        headers: { Cookie: adminCookie },
      }, env)

      const row = await db.select().from(associationConfig).where(eq(associationConfig.key, 'ai_context')).get()
      expect(row).toBeDefined()
      // Value should have been overwritten by the preset, not still the old value
      expect(JSON.parse(row!.value)).not.toBe('Old context')
    })

    it('queues bills missing summaries when applying a preset', async () => {
      const db = getDb(env.DB)
      await seedBill({ externalId: '100', tenantSummary: null, billNumber: 'HB 1', title: 'Test Bill' })
      const mockQueue = { sendBatch: vi.fn() }

      const res = await app.request('/api/admin/apply-preset/generic', {
        method: 'POST',
        headers: { Cookie: adminCookie },
      }, { ...env, BILL_QUEUE: mockQueue })

      expect(res.status).toBe(200)
      const body = await res.json() as { queuedForAi: number }
      expect(body.queuedForAi).toBe(1)
    })
  })
})

describe('GET /admin/config taxonomy handling', () => {
  let adminCookie: string

  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    const db = getDb(env.DB)
    await db.delete(associationConfig)
    const adminId = await seedUser({ role: 'admin', email: 'admin@example.com', name: 'Admin User' })
    const adminToken = await seedSession(adminId)
    adminCookie = `session=${adminToken}`
  })

  it('returns tag_taxonomy as TaxonomyItem[] when stored as old string[]', async () => {
    const db = getDb(env.DB)
    await db.insert(associationConfig).values({
      key: 'tag_taxonomy',
      value: JSON.stringify(['Voter Registration', 'Election Equipment']),
    })
    const res = await app.request('/api/admin/config', {
      headers: { cookie: adminCookie },
    }, env)
    expect(res.status).toBe(200)
    const data = await res.json() as { tag_taxonomy: unknown[] }
    expect(data.tag_taxonomy).toEqual([
      { name: 'Voter Registration' },
      { name: 'Election Equipment' },
    ])
  })

  it('returns tag_taxonomy as TaxonomyItem[] when stored as new format', async () => {
    const db = getDb(env.DB)
    await db.insert(associationConfig).values({
      key: 'tag_taxonomy',
      value: JSON.stringify([
        { name: 'Voter Registration', description: 'Processes for registering voters' },
        { name: 'Candidate Filing' },
      ]),
    })
    const res = await app.request('/api/admin/config', {
      headers: { cookie: adminCookie },
    }, env)
    expect(res.status).toBe(200)
    const data = await res.json() as { tag_taxonomy: unknown[] }
    expect(data.tag_taxonomy).toEqual([
      { name: 'Voter Registration', description: 'Processes for registering voters' },
      { name: 'Candidate Filing' },
    ])
  })
})

describe('GET /admin/presets taxonomy shape', () => {
  let adminCookie: string

  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    const adminId = await seedUser({ role: 'admin', email: 'admin@example.com', name: 'Admin User' })
    const adminToken = await seedSession(adminId)
    adminCookie = `session=${adminToken}`
  })

  it('returns taxonomy as TaxonomyItem[] on each preset', async () => {
    const res = await app.request('/api/admin/presets', {
      headers: { cookie: adminCookie },
    }, env)
    expect(res.status).toBe(200)
    const presets = await res.json() as Array<{ taxonomy: unknown[] }>
    expect(presets.length).toBeGreaterThan(0)
    for (const preset of presets) {
      expect(Array.isArray(preset.taxonomy)).toBe(true)
      for (const item of preset.taxonomy) {
        expect(item).toHaveProperty('name')
        expect(typeof (item as { name: string }).name).toBe('string')
      }
    }
  })
})

describe('Role CRUD', () => {
  let adminId: string
  let adminCookie: string
  let memberCookie: string

  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    adminId = await seedUser({ role: 'admin', email: 'admin@example.com', name: 'Admin User' })
    const adminToken = await seedSession(adminId)
    adminCookie = `session=${adminToken}`
    const memberId = await seedUser({ role: 'member', email: 'member@example.com', name: 'Member User' })
    const memberToken = await seedSession(memberId)
    memberCookie = `session=${memberToken}`
  })

  it('GET /admin/roles returns empty array initially', async () => {
    const res = await app.request('/api/admin/roles', {
      headers: { cookie: adminCookie },
    }, env)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
  })

  it('GET /admin/roles returns 401 without auth', async () => {
    const res = await app.request('/api/admin/roles', {}, env)
    expect(res.status).toBe(401)
  })

  it('GET /admin/roles returns 403 for member', async () => {
    const res = await app.request('/api/admin/roles', {
      headers: { cookie: memberCookie },
    }, env)
    expect(res.status).toBe(403)
  })

  it('POST /admin/roles creates a role', async () => {
    const res = await app.request('/api/admin/roles', {
      method: 'POST',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Elections Committee' }),
    }, env)
    expect(res.status).toBe(201)
    const data = await res.json() as { id: string; name: string }
    expect(data.name).toBe('Elections Committee')
    expect(typeof data.id).toBe('string')
  })

  it('POST /admin/roles returns 400 for empty name', async () => {
    const res = await app.request('/api/admin/roles', {
      method: 'POST',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: '   ' }),
    }, env)
    expect(res.status).toBe(400)
  })

  it('DELETE /admin/roles/:id soft-deletes the role and removes member assignments', async () => {
    const memberId2 = await seedUser({ role: 'member', email: 'member2@example.com', name: 'Member 2' })
    const roleId = await seedRole('Finance')
    await seedUserRole(memberId2, roleId)

    const res = await app.request(`/api/admin/roles/${roleId}`, {
      method: 'DELETE',
      headers: { cookie: adminCookie },
    }, env)
    expect(res.status).toBe(204)

    // No longer appears in GET /admin/roles
    const list = await app.request('/api/admin/roles', { headers: { cookie: adminCookie } }, env)
    expect(await list.json()).toEqual([])

    // Row still exists in DB with deleted_at set
    const db = getDb(env.DB)
    const row = await db.select({ deletedAt: roles.deletedAt }).from(roles).where(eq(roles.id, roleId)).get()
    expect(row).toBeDefined()
    expect(row!.deletedAt).not.toBeNull()

    // user_roles assignments cleared
    const assignments = await db.select().from(userRoles).where(eq(userRoles.roleId, roleId)).all()
    expect(assignments).toHaveLength(0)
  })

  it('DELETE /admin/roles/:id returns 404 for unknown id', async () => {
    const res = await app.request('/api/admin/roles/does-not-exist', {
      method: 'DELETE',
      headers: { cookie: adminCookie },
    }, env)
    expect(res.status).toBe(404)
  })

  it('DELETE /admin/roles/:id returns 404 when already soft-deleted', async () => {
    const roleId = await seedRole('Finance')
    await app.request(`/api/admin/roles/${roleId}`, {
      method: 'DELETE',
      headers: { cookie: adminCookie },
    }, env)
    const res = await app.request(`/api/admin/roles/${roleId}`, {
      method: 'DELETE',
      headers: { cookie: adminCookie },
    }, env)
    expect(res.status).toBe(404)
  })

  it('POST /admin/roles restores a soft-deleted role by name and preserves its UUID', async () => {
    const createRes = await app.request('/api/admin/roles', {
      method: 'POST',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Finance' }),
    }, env)
    const { id: originalId } = await createRes.json() as { id: string; name: string }

    await app.request(`/api/admin/roles/${originalId}`, {
      method: 'DELETE',
      headers: { cookie: adminCookie },
    }, env)

    const restoreRes = await app.request('/api/admin/roles', {
      method: 'POST',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Finance' }),
    }, env)
    expect(restoreRes.status).toBe(200)
    const restored = await restoreRes.json() as { id: string; name: string }
    expect(restored.id).toBe(originalId)
    expect(restored.name).toBe('Finance')

    const list = await app.request('/api/admin/roles', { headers: { cookie: adminCookie } }, env)
    const listed = await list.json() as { id: string; name: string }[]
    expect(listed).toHaveLength(1)
    expect(listed[0].id).toBe(originalId)
  })

  it('POST /admin/roles restores case-insensitively and preserves original name casing', async () => {
    const createRes = await app.request('/api/admin/roles', {
      method: 'POST',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Finance' }),
    }, env)
    const { id: originalId } = await createRes.json() as { id: string; name: string }

    await app.request(`/api/admin/roles/${originalId}`, {
      method: 'DELETE',
      headers: { cookie: adminCookie },
    }, env)

    const restoreRes = await app.request('/api/admin/roles', {
      method: 'POST',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'FINANCE' }),
    }, env)
    expect(restoreRes.status).toBe(200)
    const restored = await restoreRes.json() as { id: string; name: string }
    expect(restored.id).toBe(originalId)
    expect(restored.name).toBe('Finance')
  })

  it('POST /admin/roles returns 409 when an active role with that name already exists', async () => {
    await app.request('/api/admin/roles', {
      method: 'POST',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Finance' }),
    }, env)
    const res = await app.request('/api/admin/roles', {
      method: 'POST',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'finance' }),
    }, env)
    expect(res.status).toBe(409)
  })

  it('PATCH /admin/roles/:id renames the role', async () => {
    const roleId = await seedRole('Finance')
    const res = await app.request(`/api/admin/roles/${roleId}`, {
      method: 'PATCH',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Budget Committee' }),
    }, env)
    expect(res.status).toBe(200)
    const body = await res.json() as { id: string; name: string }
    expect(body.id).toBe(roleId)
    expect(body.name).toBe('Budget Committee')

    const list = await app.request('/api/admin/roles', { headers: { cookie: adminCookie } }, env)
    const listed = await list.json() as { id: string; name: string }[]
    expect(listed[0].name).toBe('Budget Committee')
  })

  it('PATCH /admin/roles/:id returns 409 on case-insensitive name conflict with another role', async () => {
    const roleId1 = await seedRole('Finance')
    await seedRole('Budget')
    const res = await app.request(`/api/admin/roles/${roleId1}`, {
      method: 'PATCH',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'budget' }),
    }, env)
    expect(res.status).toBe(409)
  })

  it('PATCH /admin/roles/:id allows renaming to the same name', async () => {
    const roleId = await seedRole('Finance')
    const res = await app.request(`/api/admin/roles/${roleId}`, {
      method: 'PATCH',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Finance' }),
    }, env)
    expect(res.status).toBe(200)
  })

  it('GET /roles excludes soft-deleted roles', async () => {
    const memberId2 = await seedUser({ role: 'member', email: 'member2@example.com', name: 'Member 2' })
    const token2 = await seedSession(memberId2)
    const roleId = await seedRole('Finance')

    await app.request(`/api/admin/roles/${roleId}`, {
      method: 'DELETE',
      headers: { cookie: adminCookie },
    }, env)

    const res = await app.request('/api/roles', {
      headers: { cookie: `session=${token2}` },
    }, env)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
  })
})

describe('PUT /admin/members/:id/roles', () => {
  let adminCookie: string
  let memberId: string
  let memberCookie: string

  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    const adminId = await seedUser({ role: 'admin', email: 'admin@example.com', name: 'Admin User' })
    const adminToken = await seedSession(adminId)
    adminCookie = `session=${adminToken}`
    memberId = await seedUser({ role: 'member', email: 'member@example.com', name: 'Member User' })
    const memberToken = await seedSession(memberId)
    memberCookie = `session=${memberToken}`
  })

  it('assigns roles to a member — returns 200', async () => {
    const roleId1 = await seedRole('Elections Committee')
    const roleId2 = await seedRole('Finance')

    const res = await app.request(`/api/admin/members/${memberId}/roles`, {
      method: 'PUT',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ roleIds: [roleId1, roleId2] }),
    }, env)
    expect(res.status).toBe(200)
  })

  it('clears all roles when roleIds is empty', async () => {
    const roleId = await seedRole('Elections Committee')
    await seedUserRole(memberId, roleId)

    const res = await app.request(`/api/admin/members/${memberId}/roles`, {
      method: 'PUT',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ roleIds: [] }),
    }, env)
    expect(res.status).toBe(200)
  })

  it('returns 400 for unknown roleId', async () => {
    const res = await app.request(`/api/admin/members/${memberId}/roles`, {
      method: 'PUT',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ roleIds: ['does-not-exist'] }),
    }, env)
    expect(res.status).toBe(400)
  })

  it('returns 403 for member users', async () => {
    const res = await app.request(`/api/admin/members/${memberId}/roles`, {
      method: 'PUT',
      headers: { cookie: memberCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ roleIds: [] }),
    }, env)
    expect(res.status).toBe(403)
  })
})

describe('PUT /admin/config — keyword-sync side effect', () => {
  let adminCookie: string

  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    const db = getDb(env.DB)
    await db.delete(sessions)
    await db.delete(users)
    await db.delete(associationConfig)
    const adminId = await seedUser({ role: 'admin', email: 'admin@example.com', name: 'Admin User' })
    const adminToken = await seedSession(adminId)
    adminCookie = `session=${adminToken}`

    // Reset the mock before each test
    const { registerWithCentral } = await import('../../src/cron/sync')
    vi.mocked(registerWithCentral).mockReset()
    vi.mocked(registerWithCentral).mockResolvedValue(undefined)
  })

  it('triggers registerWithCentral when keywords field is included', async () => {
    const { registerWithCentral } = await import('../../src/cron/sync')

    const res = await app.request('/api/admin/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ keywords: ['election', 'ballot'] }),
    }, env)
    expect(res.status).toBe(200)

    // Give waitUntil a chance to run (it is called synchronously in test env fallback)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(vi.mocked(registerWithCentral)).toHaveBeenCalledTimes(1)
  })

  it('does NOT trigger registerWithCentral when only non-keyword fields are updated', async () => {
    const { registerWithCentral } = await import('../../src/cron/sync')

    const res = await app.request('/api/admin/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ association_name: 'My Org' }),
    }, env)
    expect(res.status).toBe(200)

    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(vi.mocked(registerWithCentral)).not.toHaveBeenCalled()
  })
})

describe('POST /admin/keyword-resync', () => {
  let adminCookie: string

  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    const db = getDb(env.DB)
    await db.delete(associationConfig)
    const adminId = await seedUser({ role: 'admin', email: 'admin@example.com', name: 'Admin User' })
    const adminToken = await seedSession(adminId)
    adminCookie = `session=${adminToken}`
  })

  it('returns 503 when queue not configured', async () => {
    const db = getDb(env.DB)
    await db.insert(associationConfig).values({ key: 'keywords', value: JSON.stringify(['election']) })
    const res = await app.request('/api/admin/keyword-resync', {
      method: 'POST',
      headers: { Cookie: adminCookie },
    }, { ...env, BILL_QUEUE: undefined })
    expect(res.status).toBe(503)
  })

  it('returns { queued: 0, note } when no keywords configured', async () => {
    const mockQueue = { sendBatch: vi.fn() }
    const res = await app.request('/api/admin/keyword-resync', {
      method: 'POST',
      headers: { Cookie: adminCookie },
    }, { ...env, BILL_QUEUE: mockQueue })
    expect(res.status).toBe(200)
    const body = await res.json() as { queued: number; note?: string }
    expect(body.queued).toBe(0)
    expect(body.note).toBeDefined()
  })

  it('queues unprocessed bills matching keywords', async () => {
    const db = getDb(env.DB)
    await db.insert(associationConfig).values({ key: 'keywords', value: JSON.stringify(['election', 'ballot']) })

    // Matching unprocessed bill (no aiProcessedAt)
    await seedBill({ externalId: 'ocd-bill/1', title: 'Election Reform Bill', billNumber: 'HB 1' })
    // Non-matching unprocessed bill
    await seedBill({ externalId: 'ocd-bill/2', title: 'Vehicle Registration Bill', billNumber: 'HB 2' })
    // Matching but already processed — should NOT be queued
    const processedId = await seedBill({ externalId: 'ocd-bill/3', title: 'Ballot Access Bill', billNumber: 'HB 3' })
    await db.update(bills).set({ aiProcessedAt: new Date().toISOString() }).where(eq(bills.id, processedId))

    const sent: unknown[] = []
    const mockQueue = {
      sendBatch: vi.fn().mockImplementation((msgs: unknown[]) => {
        sent.push(...msgs)
        return Promise.resolve()
      }),
    }

    const res = await app.request('/api/admin/keyword-resync', {
      method: 'POST',
      headers: { Cookie: adminCookie },
    }, { ...env, BILL_QUEUE: mockQueue })

    expect(res.status).toBe(200)
    const body = await res.json() as { queued: number }
    expect(body.queued).toBe(1)
    expect(sent).toHaveLength(1)
    const msg = (sent[0] as { body: { billId: string; forceAI: boolean } }).body
    expect(msg.billId).toBe('ocd-bill/1')
    expect(msg.forceAI).toBe(true)
  })

  describe('cleanup pass — stale keyword bills', () => {
    it('demotes a keyword bill that no longer matches keywords and has no engagement', async () => {
      const db = getDb(env.DB)
      await db.insert(associationConfig).values({ key: 'keywords', value: JSON.stringify(['election']) })
      // Bill was matched by 'voting' but current keywords only have 'election'
      const billId = await seedBill({
        externalId: 'legiscan:1',
        title: 'Voting Registration Bill',
        billNumber: 'HB 1',
        matchType: 'keyword',
      })

      const mockQueue = { sendBatch: vi.fn().mockResolvedValue(undefined) }
      const res = await app.request('/api/admin/keyword-resync', {
        method: 'POST',
        headers: { Cookie: adminCookie },
      }, { ...env, BILL_QUEUE: mockQueue })

      expect(res.status).toBe(200)
      const row = await db.select({ matchType: bills.matchType }).from(bills).where(eq(bills.id, billId)).get()
      expect(row?.matchType).toBeNull()
    })

    it('promotes an engaged keyword bill that no longer matches to manual', async () => {
      const db = getDb(env.DB)
      await db.insert(associationConfig).values({ key: 'keywords', value: JSON.stringify(['election']) })
      const userId = await seedUser({ role: 'member', email: 'voter@example.com', name: 'Voter' })
      const billId = await seedBill({
        externalId: 'legiscan:2',
        title: 'Voting Registration Bill',
        billNumber: 'HB 2',
        matchType: 'keyword',
      })
      // Add a member vote (engagement)
      await db.insert(memberVotes).values({
        id: crypto.randomUUID(),
        billId,
        userId,
        position: 'support',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })

      const mockQueue = { sendBatch: vi.fn().mockResolvedValue(undefined) }
      const res = await app.request('/api/admin/keyword-resync', {
        method: 'POST',
        headers: { Cookie: adminCookie },
      }, { ...env, BILL_QUEUE: mockQueue })

      expect(res.status).toBe(200)
      const row = await db.select({ matchType: bills.matchType }).from(bills).where(eq(bills.id, billId)).get()
      expect(row?.matchType).toBe('manual')
    })

    it('does not touch a keyword bill that still matches current keywords', async () => {
      const db = getDb(env.DB)
      await db.insert(associationConfig).values({ key: 'keywords', value: JSON.stringify(['election']) })
      const billId = await seedBill({
        externalId: 'legiscan:3',
        title: 'Election Administration Bill',
        billNumber: 'HB 3',
        matchType: 'keyword',
      })

      const mockQueue = { sendBatch: vi.fn().mockResolvedValue(undefined) }
      await app.request('/api/admin/keyword-resync', {
        method: 'POST',
        headers: { Cookie: adminCookie },
      }, { ...env, BILL_QUEUE: mockQueue })

      const row = await db.select({ matchType: bills.matchType }).from(bills).where(eq(bills.id, billId)).get()
      expect(row?.matchType).toBe('keyword')
    })

    it('never touches a manual bill regardless of keyword match', async () => {
      const db = getDb(env.DB)
      await db.insert(associationConfig).values({ key: 'keywords', value: JSON.stringify(['election']) })
      const billId = await seedBill({
        externalId: 'legiscan:4',
        title: 'Parking Meter Bill',
        billNumber: 'HB 4',
        matchType: 'manual',
      })

      const mockQueue = { sendBatch: vi.fn().mockResolvedValue(undefined) }
      await app.request('/api/admin/keyword-resync', {
        method: 'POST',
        headers: { Cookie: adminCookie },
      }, { ...env, BILL_QUEUE: mockQueue })

      const row = await db.select({ matchType: bills.matchType }).from(bills).where(eq(bills.id, billId)).get()
      expect(row?.matchType).toBe('manual')
    })

    it('protects a keyword bill that has a priority (no other engagement) as manual', async () => {
      const db = getDb(env.DB)
      await db.insert(associationConfig).values({ key: 'keywords', value: JSON.stringify(['election']) })
      // Title does NOT contain 'election'; the only signal is the priority marking.
      const billId = await seedBill({
        externalId: 'legiscan:pri-1',
        title: 'Voting Registration Bill',
        billNumber: 'HB 90',
        matchType: 'keyword',
        priority: 'high',
      })

      const mockQueue = { sendBatch: vi.fn().mockResolvedValue(undefined) }
      const res = await app.request('/api/admin/keyword-resync', {
        method: 'POST', headers: { Cookie: adminCookie },
      }, { ...env, BILL_QUEUE: mockQueue })

      expect(res.status).toBe(200)
      const row = await db.select({ matchType: bills.matchType }).from(bills).where(eq(bills.id, billId)).get()
      expect(row?.matchType).toBe('manual') // protected, not demoted to null
    })
  })
})

describe('POST /admin/keyword-resync-preview — priority protection', () => {
  let adminCookie: string
  beforeEach(async () => {
    await resetDb(); await applyMigrations()
    await getDb(env.DB).delete(associationConfig)
    const adminId = await seedUser({ role: 'admin', email: 'admin@example.com', name: 'Admin User' })
    adminCookie = `session=${await seedSession(adminId)}`
  })

  it('counts a priority-only stale bill under wouldProtect, not wouldDemote', async () => {
    const db = getDb(env.DB)
    await db.insert(associationConfig).values({ key: 'keywords', value: JSON.stringify(['election']) })
    await seedBill({ externalId: 'legiscan:pv-1', title: 'Voting Registration Bill', billNumber: 'HB 91', matchType: 'keyword', priority: 'low' })

    const res = await app.request('/api/admin/keyword-resync-preview', {
      method: 'POST', headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ keywords: ['election'] }),
    }, env)
    expect(res.status).toBe(200)
    const body = await res.json() as { wouldDemote: number; wouldProtect: number }
    expect(body.wouldProtect).toBe(1)
    expect(body.wouldDemote).toBe(0)
  })
})

describe('POST /admin/reprocess-llm-all — scope', () => {
  let adminCookie: string

  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    const adminId = await seedUser({ role: 'admin', email: 'admin@example.com', name: 'Admin User' })
    const adminToken = await seedSession(adminId)
    adminCookie = `session=${adminToken}`
  })

  async function callReprocess(scope?: string) {
    const sent: { body: { billId: string; forceAI?: boolean } }[] = []
    const mockQueue = {
      sendBatch: vi.fn().mockImplementation((msgs: { body: { billId: string; forceAI?: boolean } }[]) => {
        sent.push(...msgs)
        return Promise.resolve()
      }),
    }
    const url = scope ? `/api/admin/reprocess-llm-all?scope=${scope}` : '/api/admin/reprocess-llm-all'
    const res = await app.request(url, { method: 'POST', headers: { Cookie: adminCookie } }, { ...env, BILL_QUEUE: mockQueue })
    const body = await res.json() as { queued: number; scope: string }
    return { res, body, sent }
  }

  it('scope=all queues every keyword/manual bill (default behavior)', async () => {
    await seedBill({ externalId: 'legiscan:1', billNumber: 'HB 1', matchType: 'keyword', priority: 'high' })
    await seedBill({ externalId: 'legiscan:2', billNumber: 'HB 2', matchType: 'manual', priority: null })
    await seedBill({ externalId: 'legiscan:3', billNumber: 'HB 3', matchType: null, priority: null }) // stub — never queued

    const { res, body, sent } = await callReprocess('all')
    expect(res.status).toBe(200)
    expect(body.queued).toBe(2)
    expect(body.scope).toBe('all')
    expect(sent.map(m => m.body.billId).sort()).toEqual(['legiscan:1', 'legiscan:2'])
    expect(sent.every(m => m.body.forceAI === true)).toBe(true)
  })

  it('no scope param behaves as scope=all', async () => {
    await seedBill({ externalId: 'legiscan:1', billNumber: 'HB 1', matchType: 'keyword', priority: null })
    const { body } = await callReprocess()
    expect(body.queued).toBe(1)
    expect(body.scope).toBe('all')
  })

  it('scope=prioritized queues only bills with a non-null priority', async () => {
    await seedBill({ externalId: 'legiscan:1', billNumber: 'HB 1', matchType: 'keyword', priority: 'high' })
    await seedBill({ externalId: 'legiscan:2', billNumber: 'HB 2', matchType: 'manual', priority: 'low' })
    await seedBill({ externalId: 'legiscan:3', billNumber: 'HB 3', matchType: 'keyword', priority: null }) // no priority — skipped
    await seedBill({ externalId: 'legiscan:4', billNumber: 'HB 4', matchType: null, priority: 'high' }) // stub — skipped

    const { body, sent } = await callReprocess('prioritized')
    expect(body.queued).toBe(2)
    expect(body.scope).toBe('prioritized')
    expect(sent.map(m => m.body.billId).sort()).toEqual(['legiscan:1', 'legiscan:2'])
  })

  it('returns 503 when queue not configured', async () => {
    const res = await app.request('/api/admin/reprocess-llm-all', { method: 'POST', headers: { Cookie: adminCookie } }, { ...env, BILL_QUEUE: undefined })
    expect(res.status).toBe(503)
  })
})

describe('GET /admin/members/:id/auth-events', () => {
  let adminCookie: string

  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    const adminId = await seedUser({ role: 'admin', email: 'admin@example.com' })
    const adminToken = await seedSession(adminId)
    adminCookie = `session=${adminToken}`
  })

  it("returns a user's events newest-first", async () => {
    const uid = await seedUser({ email: 'timeline@b.com' })
    await seedAuthEvent(uid, 'link_requested', { linkType: 'login' })
    await seedAuthEvent(uid, 'verify_failed', { reason: 'expired' })
    const res = await app.request(
      `/api/admin/members/${uid}/auth-events`,
      { headers: { Cookie: adminCookie } },
      env,
    )
    expect(res.status).toBe(200)
    const body = await res.json() as { events: Array<{ event: string }> }
    expect(body.events.length).toBe(2)
  })

  it('requires admin auth', async () => {
    const uid = await seedUser({ email: 'x@b.com' })
    const res = await app.request(`/api/admin/members/${uid}/auth-events`, {}, env)
    expect(res.status).toBe(401)
  })

  it('includes suppression status from central in the auth-events response', async () => {
    const uid = await seedUser({ email: 'sup@b.com' })
    const CENTRAL = { emailSuppression: async () => ({ suppressed: true, reason: 'hard_bounce' }) }
    const res = await app.request(`/api/admin/members/${uid}/auth-events`,
      { headers: { Cookie: adminCookie } },
      { ...env, CENTRAL })
    const body = await res.json() as { suppression: { suppressed: boolean | null } }
    expect(body.suppression.suppressed).toBe(true)
  })

  it('attaches delivery status for sent-email message ids', async () => {
    const uid = await seedUser({ email: 'deliv@b.com' })
    const db = getDb(env.DB)
    await db.insert(authEvents).values({ id: crypto.randomUUID(), userId: uid, email: 'deliv@b.com', event: 'email_sent', messageId: 'm1', linkType: 'login' })
    const CENTRAL = {
      emailSuppression: async () => ({ suppressed: null }),
      emailDeliveryStatus: async () => ({ m1: { status: 'delivered', isSpam: false } }),
    }
    const res = await app.request(`/api/admin/members/${uid}/auth-events`, { headers: { Cookie: adminCookie } }, { ...env, CENTRAL })
    const body = await res.json() as { delivery: Record<string, { status: string }> }
    expect(body.delivery.m1.status).toBe('delivered')
  })
})

describe('GET /admin/members — loginTrouble flag', () => {
  let adminCookie: string

  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    const adminId = await seedUser({ role: 'admin', email: 'admin@example.com', name: 'Admin User' })
    const adminToken = await seedSession(adminId)
    adminCookie = `session=${adminToken}`
  })

  it('flags a user with >=2 requests and 0 sign-ins in 14d', async () => {
    const stuck = await seedUser({ email: 'stuck@b.com' })
    await seedAuthEvent(stuck, 'link_requested', { linkType: 'login' })
    await seedAuthEvent(stuck, 'link_requested', { linkType: 'login' })
    const res = await app.request('/api/admin/members', { headers: { Cookie: adminCookie } }, env)
    const rows = await res.json() as Array<{ id: string; loginTrouble: boolean }>
    expect(rows.find(r => r.id === stuck)?.loginTrouble).toBe(true)
  })

  it('does NOT flag a user who eventually signed in', async () => {
    const ok = await seedUser({ email: 'ok@b.com' })
    await seedAuthEvent(ok, 'link_requested', { linkType: 'login' })
    await seedAuthEvent(ok, 'link_requested', { linkType: 'login' })
    await seedAuthEvent(ok, 'verify_success')
    const res = await app.request('/api/admin/members', { headers: { Cookie: adminCookie } }, env)
    const rows = await res.json() as Array<{ id: string; loginTrouble: boolean }>
    expect(rows.find(r => r.id === ok)?.loginTrouble).toBe(false)
  })

  it('does NOT flag a fresh single-invite user', async () => {
    const invited = await seedUser({ email: 'invited@b.com' })
    await seedAuthEvent(invited, 'link_requested', { linkType: 'invite' })
    const res = await app.request('/api/admin/members', { headers: { Cookie: adminCookie } }, env)
    const rows = await res.json() as Array<{ id: string; loginTrouble: boolean }>
    expect(rows.find(r => r.id === invited)?.loginTrouble).toBe(false)
  })

  it('flags a user who signed in once then later got locked out', async () => {
    // The motivating case: accepted (verify_success), then repeated login-link requests
    // after, with no success since. Uses controlled space-format timestamps so the
    // "last request is more recent than last success" predicate is exercised deterministically.
    const uid = await seedUser({ email: 'lockedout@b.com' })
    const db = getDb(env.DB)
    const ago = (days: number) => new Date(Date.now() - days * 86400_000).toISOString().slice(0, 19).replace('T', ' ')
    const ev = (event: string, linkType: string | null, createdAt: string) =>
      db.insert(authEvents).values({ id: crypto.randomUUID(), userId: uid, email: 'lockedout@b.com', event, linkType, createdAt })
    await ev('verify_success', null, ago(6))     // logged in 6 days ago
    await ev('link_requested', 'login', ago(2))  // then asked for links since, no success
    await ev('link_requested', 'login', ago(1))
    const res = await app.request('/api/admin/members', { headers: { Cookie: adminCookie } }, env)
    const rows = await res.json() as Array<{ id: string; loginTrouble: boolean }>
    expect(rows.find(r => r.id === uid)?.loginTrouble).toBe(true)
  })
})

describe('GET /admin/unknown-login-attempts', () => {
  let adminCookie: string

  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    const adminId = await seedUser({ role: 'admin', email: 'admin@example.com' })
    const adminToken = await seedSession(adminId)
    adminCookie = `session=${adminToken}`
  })

  it('returns recorded unknown login attempts', async () => {
    const db = getDb(env.DB)
    await db.insert(authEvents).values({
      id: crypto.randomUUID(),
      email: 'stranger@example.com',
      event: 'link_requested_unknown',
      linkType: 'login',
      ipCountry: 'US',
      userAgent: 'Mozilla/5.0',
    })
    await db.insert(authEvents).values({
      id: crypto.randomUUID(),
      email: 'known@example.com',
      event: 'link_requested',
      userId: 'some-user',
      linkType: 'login',
    })
    const res = await app.request('/api/admin/unknown-login-attempts', {
      headers: { Cookie: adminCookie },
    }, env)
    expect(res.status).toBe(200)
    const body = await res.json() as { attempts: Array<{ email: string }> }
    expect(body.attempts).toHaveLength(1)
    expect(body.attempts[0].email).toBe('stranger@example.com')
  })
})
