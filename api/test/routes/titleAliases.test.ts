import { describe, it, expect, beforeEach } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { eq } from 'drizzle-orm'
import { resetDb, applyMigrations, seedUser, seedSession, seedBill, seedComment, seedRole, seedUserRole } from '../helpers'
import { getDb } from '../../src/db/client'
import { commentReactions, feedEvents, users } from '../../src/db/schema'
import { writeNotifications } from '../../src/lib/notifications'

// A member's title was `subtitle` before #539. For one release, a tab still on
// the previous web bundle keeps working across the deploy: `PATCH /users/me`
// accepts `subtitle`, and every response that carried `subtitle` carries it
// beside `title`. Remove all of this in the release after this one.

let adminCookie: string
let alice: string
const call = (path: string, init: RequestInit = {}) => SELF.fetch(`http://localhost/api${path}`, init)

beforeEach(async () => {
  await resetDb()
  await applyMigrations()
  alice = await seedUser({ name: 'Alice', email: 'alice@example.com', role: 'admin', title: 'Town Clerk' })
  adminCookie = `session=${await seedSession(alice)}`
})

describe('PATCH /users/me from the previous web bundle', () => {
  const patch = (body: unknown) => call('/users/me', {
    method: 'PATCH',
    headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const storedTitle = async () => (await getDb(env.DB).select({ title: users.title }).from(users).where(eq(users.id, alice)).get())?.title

  it('saves a `subtitle` key as the title and echoes it under both names', async () => {
    const res = await patch({ subtitle: 'County Clerk' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ title: 'County Clerk', subtitle: 'County Clerk' })
    expect(await storedTitle()).toBe('County Clerk')
  })

  it('clears the title for a blank `subtitle`', async () => {
    await patch({ subtitle: '   ' })
    expect(await storedTitle()).toBeNull()
  })

  it('still rejects a `subtitle` over 200 characters, naming the Title', async () => {
    const res = await patch({ subtitle: 'x'.repeat(201) })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'Title too long (max 200 characters)' })
  })

  it('echoes a `title` save under both names too', async () => {
    const res = await patch({ title: 'Registrar' })
    expect(await res.json()).toEqual({ title: 'Registrar', subtitle: 'Registrar' })
  })
})

describe('responses that carried `subtitle` still carry it', () => {
  it('GET /users', async () => {
    const res = await call('/users', { headers: { Cookie: adminCookie } })
    const me = ((await res.json()) as Array<Record<string, unknown>>).find(u => u.id === alice)!
    expect([me.title, me.subtitle]).toEqual(['Town Clerk', 'Town Clerk'])
  })

  it('GET /roles members', async () => {
    await seedUserRole(alice, await seedRole('Elections Committee'))
    const res = await call('/roles', { headers: { Cookie: adminCookie } })
    const member = ((await res.json()) as Array<{ members: Array<Record<string, unknown>> }>)[0].members[0]
    expect([member.title, member.subtitle]).toEqual(['Town Clerk', 'Town Clerk'])
  })

  it('GET /auth/me', async () => {
    const res = await call('/auth/me', { headers: { Cookie: adminCookie } })
    const me = (await res.json()) as Record<string, unknown>
    expect([me.title, me.subtitle]).toEqual(['Town Clerk', 'Town Clerk'])
  })

  it('GET /admin/members', async () => {
    const res = await call('/admin/members', { headers: { Cookie: adminCookie } })
    const me = ((await res.json()) as Array<Record<string, unknown>>).find(u => u.id === alice)!
    expect([me.title, me.subtitle]).toEqual(['Town Clerk', 'Town Clerk'])
  })

  it('a bill\'s comments and their reactors', async () => {
    const bill = await seedBill({ billNumber: 'HB 1' })
    const commentId = await seedComment(bill, alice, '<p>hi</p>')
    await getDb(env.DB).insert(commentReactions).values({ id: crypto.randomUUID(), commentId, userId: alice, emoji: '👍' })
    const res = await call(`/bills/${bill}`, { headers: { Cookie: adminCookie } })
    const body = (await res.json()) as { comments: Array<Record<string, any>> }
    const c = body.comments[0]
    expect([c.userTitle, c.userSubtitle]).toEqual(['Town Clerk', 'Town Clerk'])
    expect([c.reactions[0].reactors[0].title, c.reactions[0].reactors[0].subtitle]).toEqual(['Town Clerk', 'Town Clerk'])
  })

  it('the comments list for a bill', async () => {
    const bill = await seedBill({ billNumber: 'HB 2' })
    const commentId = await seedComment(bill, alice, '<p>hi</p>')
    await getDb(env.DB).insert(commentReactions).values({ id: crypto.randomUUID(), commentId, userId: alice, emoji: '👍' })
    const res = await call(`/bills/${bill}/comments`, { headers: { Cookie: adminCookie } })
    const rows = (await res.json()) as Array<Record<string, any>>
    const c = rows[0]
    expect([c.userTitle, c.userSubtitle]).toEqual(['Town Clerk', 'Town Clerk'])
    expect([c.reactions[0].reactors[0].title, c.reactions[0].reactors[0].subtitle]).toEqual(['Town Clerk', 'Town Clerk'])
  })

  it('GET /feed', async () => {
    const bill = await seedBill({ billNumber: 'HB 3' })
    await getDb(env.DB).insert(feedEvents).values({ id: crypto.randomUUID(), type: 'bill_added', billId: bill, userId: alice, metadata: '{}', createdAt: '2026-01-01T09:00:00Z' })
    const res = await call('/feed', { headers: { Cookie: adminCookie } })
    const event = ((await res.json()) as { events: Array<Record<string, unknown>> }).events[0]
    expect([event.userTitle, event.userSubtitle]).toEqual(['Town Clerk', 'Town Clerk'])
  })

  it('GET /notifications authors', async () => {
    const bill = await seedBill({ billNumber: 'HB 4' })
    const bob = await seedUser({ name: 'Bob', email: 'bob@example.com' })
    const commentId = await seedComment(bill, alice, '<p>a reply</p>')
    await writeNotifications(getDb(env.DB), [{ recipientId: bob, kind: 'reply', billId: bill, commentId, actorId: alice, data: {} }])
    const res = await call('/notifications', { headers: { Cookie: `session=${await seedSession(bob)}` } })
    const row = ((await res.json()) as { notifications: Array<Record<string, unknown>> }).notifications[0]
    expect([row.authorTitle, row.authorSubtitle]).toEqual(['Town Clerk', 'Town Clerk'])
  })
})
