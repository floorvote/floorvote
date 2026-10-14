import { describe, it, expect, vi, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { eq } from 'drizzle-orm'
import { app } from '../index'
import { resetDb, applyMigrations, seedUser, seedSession, seedAuthEvent } from '../../test/helpers'
import { getDb } from '../db/client'
import { users, authEvents } from '../db/schema'
import { sendMagicLink } from '../lib/email'
import { ADMIN_SEND_LIMITS, ADMIN_SEND_LIMIT_MESSAGES } from '../lib/adminSendLimits'

vi.mock('../lib/centralFetch', () => ({
  centralFetch: vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }),
}))
vi.mock('../cron/sync', () => ({ registerWithCentral: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../lib/email', () => ({ sendMagicLink: vi.fn().mockResolvedValue(undefined) }))

const PER_MEMBER = ADMIN_SEND_LIMITS.perMember.max
const PER_ADMIN = ADMIN_SEND_LIMITS.perAdmin.max

type Reply = { status: number; body: { ok?: boolean; error?: string } }

async function post(path: string, cookie: string, body?: unknown): Promise<Reply> {
  const central = {
    emailSuppressionMany: async (emails: string[]) =>
      Object.fromEntries(emails.map(e => [e, { suppressed: false }])),
  } as unknown as Fetcher
  const res = await app.request(path, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  }, { ...env, CENTRAL: central })
  return { status: res.status, body: await res.json() as Reply['body'] }
}

// The three admin routes that send email. `n` gives each call a fresh address
// where the route needs one (change-email rejects "no change").
const ROUTES = [
  {
    name: 'resend-invite',
    send: (id: string, cookie: string) => post(`/api/admin/members/${id}/resend-invite`, cookie),
  },
  {
    name: 'resend-login',
    send: (id: string, cookie: string) => post(`/api/admin/members/${id}/resend-login`, cookie),
  },
  {
    name: 'change-email',
    send: (id: string, cookie: string) =>
      post(`/api/admin/members/${id}/change-email`, cookie, { email: `fixed-${crypto.randomUUID()}@example.com` }),
  },
]

describe('admin email routes: rate limits', () => {
  let adminId: string
  let adminCookie: string

  async function seedPending(email = `pending-${crypto.randomUUID()}@example.com`) {
    const id = await seedUser({ email, name: 'Pending Person' })
    await getDb(env.DB).update(users).set({ invitedBy: adminId }).where(eq(users.id, id))
    return id
  }

  /** Admin-attributed send events, as the routes record them. */
  async function seedSends(opts: { actorId: string; userId: string; count: number; createdAt?: string }) {
    for (let i = 0; i < opts.count; i++) {
      await seedAuthEvent(opts.userId, 'link_requested', { linkType: 'invite', actorId: opts.actorId, createdAt: opts.createdAt })
    }
  }

  beforeEach(async () => {
    vi.mocked(sendMagicLink).mockClear()
    await resetDb()
    await applyMigrations()
    adminId = await seedUser({ role: 'admin', email: 'admin@example.com', name: 'Ada Admin' })
    adminCookie = `session=${await seedSession(adminId)}`
  })

  describe.each(ROUTES)('$name', ({ send }) => {
    it('is unaffected by normal use: a few resends to a member all go through', async () => {
      const target = await seedPending()
      for (let n = 0; n < 3; n++) {
        const r = await send(target, adminCookie)
        expect(r.status).toBe(200)
      }
      expect(sendMagicLink).toHaveBeenCalledTimes(3)
    })

    it('stops sending to one member after the per-member limit, with a clear 429', async () => {
      const target = await seedPending()
      for (let n = 0; n < PER_MEMBER; n++) expect((await send(target, adminCookie)).status).toBe(200)

      const blocked = await send(target, adminCookie)
      expect(blocked.status).toBe(429)
      expect(blocked.body.error).toBe(ADMIN_SEND_LIMIT_MESSAGES.perMember)
      expect(sendMagicLink).toHaveBeenCalledTimes(PER_MEMBER)

      // Another member is a separate bucket.
      const other = await seedPending()
      expect((await send(other, adminCookie)).status).toBe(200)
    })

    it('counts sends from every admin against one member', async () => {
      const target = await seedPending()
      const otherAdmin = await seedUser({ role: 'admin', email: 'grace@example.com' })
      await seedSends({ actorId: otherAdmin, userId: target, count: PER_MEMBER })

      const r = await send(target, adminCookie)
      expect(r.status).toBe(429)
      expect(r.body.error).toBe(ADMIN_SEND_LIMIT_MESSAGES.perMember)
    })

    it('stops one admin after the per-admin limit, whoever the member is, with a clear 429', async () => {
      const target = await seedPending()
      const earlier = await seedPending()
      await seedSends({ actorId: adminId, userId: earlier, count: PER_ADMIN })

      const blocked = await send(target, adminCookie)
      expect(blocked.status).toBe(429)
      expect(blocked.body.error).toBe(ADMIN_SEND_LIMIT_MESSAGES.perAdmin)
      expect(sendMagicLink).not.toHaveBeenCalled()

      // A different admin is not held up by this one's sends.
      const otherAdmin = await seedUser({ role: 'admin', email: 'grace@example.com' })
      const otherCookie = `session=${await seedSession(otherAdmin)}`
      expect((await send(target, otherCookie)).status).toBe(200)
    })

    it('lets sends through again once the window has passed', async () => {
      const target = await seedPending()
      await seedSends({ actorId: adminId, userId: target, count: PER_ADMIN + PER_MEMBER, createdAt: '2020-01-01 00:00:00' })

      expect((await send(target, adminCookie)).status).toBe(200)
    })

    it("does not count a member's own sign-in requests against the admin's resends", async () => {
      const target = await seedPending()
      for (let i = 0; i < PER_MEMBER + 2; i++) await seedAuthEvent(target, 'link_requested', { linkType: 'login' })

      expect((await send(target, adminCookie)).status).toBe(200)
    })
  })

  describe('across routes', () => {
    it('shares one per-member count, so mixing routes cannot multiply the limit', async () => {
      const target = await seedPending()
      // Fill the member's allowance by alternating routes.
      for (let n = 0; n < PER_MEMBER; n++) {
        expect((await ROUTES[n % ROUTES.length].send(target, adminCookie)).status).toBe(200)
      }
      for (const route of ROUTES) {
        expect((await route.send(target, adminCookie)).status).toBe(429)
      }
    })
  })

  describe.each(ROUTES)('$name, requests fired at once', ({ send }) => {
    it('lets exactly the per-member limit through', async () => {
      const target = await seedPending()
      const replies = await Promise.all(Array.from({ length: 20 }, () => send(target, adminCookie)))

      expect(replies.filter(r => r.status === 200)).toHaveLength(PER_MEMBER)
      expect(replies.filter(r => r.status === 429)).toHaveLength(20 - PER_MEMBER)
      expect(sendMagicLink).toHaveBeenCalledTimes(PER_MEMBER)
    })

    it('lets exactly the per-admin limit through', async () => {
      const room = 3
      const earlier = await seedPending()
      await seedSends({ actorId: adminId, userId: earlier, count: PER_ADMIN - room })
      const targets = await Promise.all(Array.from({ length: 10 }, () => seedPending()))

      const replies = await Promise.all(targets.map(t => send(t, adminCookie)))

      expect(replies.filter(r => r.status === 200)).toHaveLength(room)
      expect(replies.filter(r => r.status === 429)).toHaveLength(10 - room)
      expect(sendMagicLink).toHaveBeenCalledTimes(room)
    })
  })

  describe('per address', () => {
    it('refuses the sixth admin send to one inbox, even when the address is rotated through different members', async () => {
      const victim = 'victim@example.com'
      const limit = ADMIN_SEND_LIMITS.perAddress.max
      // Each member takes the victim's address, then moves off it for the next.
      for (let i = 0; i < limit; i++) {
        const member = await seedPending(`typo-${i}@exmaple.com`)
        expect((await post(`/api/admin/members/${member}/change-email`, adminCookie, { email: victim })).status).toBe(200)
        expect((await post(`/api/admin/members/${member}/change-email`, adminCookie, { email: `elsewhere-${i}@example.com` })).status).toBe(200)
      }

      const last = await seedPending('typo-last@exmaple.com')
      const blocked = await post(`/api/admin/members/${last}/change-email`, adminCookie, { email: victim })
      expect(blocked.status).toBe(429)
      expect(blocked.body.error).toBe(ADMIN_SEND_LIMIT_MESSAGES.perAddress)
      const row = await getDb(env.DB).select({ email: users.email }).from(users).where(eq(users.id, last)).get()
      expect(row?.email).toBe('typo-last@exmaple.com')
    })

    it('counts the address case-insensitively', async () => {
      const target = await seedPending('Mixed.Case@Example.com')
      for (let n = 0; n < ADMIN_SEND_LIMITS.perAddress.max; n++) {
        await seedAuthEvent(await seedPending(), 'link_requested', { email: 'mixed.case@example.com', linkType: 'invite', actorId: adminId })
      }
      const r = await ROUTES[0].send(target, adminCookie)
      expect(r.status).toBe(429)
      expect(r.body.error).toBe(ADMIN_SEND_LIMIT_MESSAGES.perAddress)
    })
  })

  describe("a member's own sign-in requests", () => {
    it('do not block an admin resending their sign-in link', async () => {
      const address = 'not-getting-mail@example.com'
      const target = await seedPending(address)
      // The member presses "send link" on the public form until its own cap.
      for (let i = 0; i < 5; i++) {
        expect((await post('/api/auth/magic-link', '', { email: address })).status).toBe(200)
      }

      const r = await post(`/api/admin/members/${target}/resend-login`, adminCookie)
      expect(r.status).toBe(200)
    })
  })

  describe('a send that does not happen', () => {
    it('is not counted when it is refused', async () => {
      const target = await seedPending()
      await seedSends({ actorId: adminId, userId: target, count: PER_MEMBER })
      for (let i = 0; i < 3; i++) expect((await ROUTES[0].send(target, adminCookie)).status).toBe(429)

      const rows = await getDb(env.DB).select().from(authEvents).where(eq(authEvents.userId, target)).all()
      expect(rows).toHaveLength(PER_MEMBER)
    })

    it('records exactly one link_requested event per send, with the admin as actor', async () => {
      const target = await seedPending()
      expect((await ROUTES[1].send(target, adminCookie)).status).toBe(200)
      const rows = await getDb(env.DB).select().from(authEvents).where(eq(authEvents.userId, target)).all()
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ event: 'link_requested', linkType: 'login', actorId: adminId })
    })
  })

  describe('change-email', () => {
    it('leaves the address alone when the limit blocks the change', async () => {
      const target = await seedPending('jane@exmaple.com')
      await seedSends({ actorId: adminId, userId: target, count: PER_MEMBER })

      const r = await ROUTES[2].send(target, adminCookie)
      expect(r.status).toBe(429)
      const row = await getDb(env.DB).select({ email: users.email }).from(users).where(eq(users.id, target)).get()
      expect(row?.email).toBe('jane@exmaple.com')
    })

    it('does not count requests that fail validation, so fixing a typo is not held up by them', async () => {
      const target = await seedPending('jane@exmaple.com')
      for (let i = 0; i < PER_MEMBER + 2; i++) {
        const bad = await post(`/api/admin/members/${target}/change-email`, adminCookie, { email: 'not-an-address' })
        expect(bad.status).toBe(400)
      }
      expect((await ROUTES[2].send(target, adminCookie)).status).toBe(200)
    })
  })
})
