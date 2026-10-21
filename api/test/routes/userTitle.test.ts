import { describe, it, expect, beforeEach } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { getTableColumns } from 'drizzle-orm'
import { clearDb, stubFetch, seedUser, seedSession, seedBill, seedComment, seedRole, seedUserRole } from '../helpers'
import { getDb } from '../../src/db/client'
import { commentReactions, feedEvents, users } from '../../src/db/schema'
import { writeNotifications } from '../../src/lib/notifications'

// A member's line under their name is `users.title` and nothing else (#539,
// #564). Migration 0105 renamed it in two steps and kept `subtitle` for one
// release, with the API accepting and returning `subtitle` as an alias. This
// build no longer declares the column (a later migration drops it, see
// userTitleBesideSubtitle.test.ts), so the API no longer returns `subtitle`
// anywhere and no longer reads it from a request.

const call = (path: string, init: RequestInit = {}) => SELF.fetch(`http://localhost/api${path}`, init)

/** The title as stored. */
const storedTitle = async (id: string) =>
  (await env.DB.prepare('SELECT title FROM users WHERE id = ?').bind(id).first<{ title: string | null }>())?.title

/** The body's JSON with every key printed, so a `subtitle` key anywhere in it, however deep, shows. */
async function bodyText(res: Response): Promise<string> {
  expect(res.status).toBe(200)
  return JSON.stringify(await res.json())
}

beforeEach(async () => {
  await clearDb()
  // The first PATCH /users/me looks up central's superadmin allowlist (cached for the rest of the file),
  // and the network guard refuses a fetch no test stubbed. An empty allowlist: nobody here is a superadmin.
  stubFetch(url => (new URL(url).pathname === '/api/admin/superadmin/emails'
    ? new Response(JSON.stringify({ hashes: [] }), { status: 200 })
    : new Response('not found', { status: 404 })))
})

describe('the schema', () => {
  it('declares no subtitle column on users', () => {
    expect(Object.keys(getTableColumns(users))).not.toContain('subtitle')
    expect(Object.keys(getTableColumns(users))).toContain('title')
  })

  it('seeds a member\'s title into users.title alone', async () => {
    const id = await seedUser({ title: 'Seeded' })
    expect(await storedTitle(id)).toBe('Seeded')
    expect(await storedTitle(await seedUser({}))).toBeNull()
  })
})

describe('PATCH /users/me', () => {
  let alice: string
  let cookie: string
  beforeEach(async () => {
    alice = await seedUser({ name: 'Alice', email: 'alice@example.com', role: 'admin', title: 'Town Clerk' })
    cookie = `session=${await seedSession(alice)}`
  })
  const patch = (body: unknown) => call('/users/me', {
    method: 'PATCH',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

  it('saves a title and echoes only `title`', async () => {
    const res = await patch({ title: 'Registrar' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ title: 'Registrar' })
    expect(await storedTitle(alice)).toBe('Registrar')
  })

  it('trims the title', async () => {
    await patch({ title: '  Registrar  ' })
    expect(await storedTitle(alice)).toBe('Registrar')
  })

  it('clears the title for a blank or null one', async () => {
    await patch({ title: '   ' })
    expect(await storedTitle(alice)).toBeNull()
    await patch({ title: 'Town Clerk' })
    await patch({ title: null })
    expect(await storedTitle(alice)).toBeNull()
  })

  it('refuses a title over 200 characters, or one that is not a string, and writes nothing', async () => {
    const tooLong = await patch({ title: 'x'.repeat(201) })
    expect(tooLong.status).toBe(400)
    expect(await tooLong.json()).toEqual({ error: 'Title too long (max 200 characters)' })
    expect((await patch({ title: 42 })).status).toBe(400)
    expect(await storedTitle(alice)).toBe('Town Clerk')
  })

  it('leaves the title alone when only other settings are saved', async () => {
    await patch({ name: 'Alice B', emailDigestEnabled: false })
    expect(await storedTitle(alice)).toBe('Town Clerk')
  })

  it('no longer accepts a `subtitle` key: it changes nothing and is not echoed', async () => {
    const res = await patch({ subtitle: 'County Clerk' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({})
    expect(await storedTitle(alice)).toBe('Town Clerk')
  })

  it('ignores a blank, null, or over-long `subtitle` instead of clearing the title or refusing it', async () => {
    for (const subtitle of ['   ', null, 'x'.repeat(201)]) {
      const res = await patch({ subtitle })
      expect(res.status).toBe(200)
      expect(await storedTitle(alice)).toBe('Town Clerk')
    }
  })

  it('saves `title` and ignores a `subtitle` sent beside it', async () => {
    const res = await patch({ title: 'New', subtitle: 'Old' })
    expect(await res.json()).toEqual({ title: 'New' })
    expect(await storedTitle(alice)).toBe('New')
  })

  it('still saves the other settings sent beside a `subtitle`', async () => {
    const res = await patch({ subtitle: 'Old', name: 'Alice B' })
    expect(await res.json()).toEqual({ name: 'Alice B' })
    expect(await storedTitle(alice)).toBe('Town Clerk')
  })

  it('a member edit by an admin leaves the title as it was', async () => {
    const bob = await seedUser({ name: 'Bob', email: 'bob@example.com', title: 'Analyst' })
    const res = await call(`/admin/members/${bob}`, {
      method: 'PATCH',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ canVote: false }),
    })
    expect(res.status).toBe(200)
    expect(await storedTitle(bob)).toBe('Analyst')
  })
})

describe('no response carries `subtitle`, and each still carries the title', () => {
  let alice: string
  let cookie: string
  beforeEach(async () => {
    alice = await seedUser({ name: 'Alice', email: 'alice@example.com', role: 'admin', title: 'Town Clerk' })
    cookie = `session=${await seedSession(alice)}`
  })

  it('GET /users', async () => {
    const text = await bodyText(await call('/users', { headers: { Cookie: cookie } }))
    expect(text).not.toMatch(/subtitle/i)
    expect(text).toContain('"title":"Town Clerk"')
  })

  it('GET /roles members', async () => {
    await seedUserRole(alice, await seedRole('Elections Committee'))
    const text = await bodyText(await call('/roles', { headers: { Cookie: cookie } }))
    expect(text).not.toMatch(/subtitle/i)
    expect(text).toContain('"title":"Town Clerk"')
  })

  it('GET /auth/me', async () => {
    const text = await bodyText(await call('/auth/me', { headers: { Cookie: cookie } }))
    expect(text).not.toMatch(/subtitle/i)
    expect(text).toContain('"title":"Town Clerk"')
  })

  it('GET /admin/members', async () => {
    const text = await bodyText(await call('/admin/members', { headers: { Cookie: cookie } }))
    expect(text).not.toMatch(/subtitle/i)
    expect(text).toContain('"title":"Town Clerk"')
  })

  it('a bill\'s comments and their reactors', async () => {
    const bill = await seedBill({ billNumber: 'HB 1' })
    const commentId = await seedComment(bill, alice, '<p>hi</p>')
    await getDb(env.DB).insert(commentReactions).values({ id: crypto.randomUUID(), commentId, userId: alice, emoji: '👍' })
    const res = await call(`/bills/${bill}`, { headers: { Cookie: cookie } })
    const body = (await res.clone().json()) as { comments: Array<Record<string, any>> }
    expect(await bodyText(res)).not.toMatch(/subtitle/i)
    expect(body.comments[0].userTitle).toBe('Town Clerk')
    expect(body.comments[0].reactions[0].reactors[0].title).toBe('Town Clerk')
  })

  it('the comments list for a bill', async () => {
    const bill = await seedBill({ billNumber: 'HB 2' })
    const commentId = await seedComment(bill, alice, '<p>hi</p>')
    await getDb(env.DB).insert(commentReactions).values({ id: crypto.randomUUID(), commentId, userId: alice, emoji: '👍' })
    const res = await call(`/bills/${bill}/comments`, { headers: { Cookie: cookie } })
    const rows = (await res.clone().json()) as Array<Record<string, any>>
    expect(await bodyText(res)).not.toMatch(/subtitle/i)
    expect(rows[0].userTitle).toBe('Town Clerk')
    expect(rows[0].reactions[0].reactors[0].title).toBe('Town Clerk')
  })

  it('GET /feed', async () => {
    const bill = await seedBill({ billNumber: 'HB 3' })
    await getDb(env.DB).insert(feedEvents).values({ id: crypto.randomUUID(), type: 'bill_added', billId: bill, userId: alice, metadata: '{}', createdAt: '2026-01-01T09:00:00Z' })
    const res = await call('/feed', { headers: { Cookie: cookie } })
    const event = ((await res.clone().json()) as { events: Array<Record<string, unknown>> }).events[0]
    expect(await bodyText(res)).not.toMatch(/subtitle/i)
    expect(event.userTitle).toBe('Town Clerk')
  })

  it('GET /notifications authors', async () => {
    const bill = await seedBill({ billNumber: 'HB 4' })
    const bob = await seedUser({ name: 'Bob', email: 'bob@example.com' })
    const commentId = await seedComment(bill, alice, '<p>a reply</p>')
    await writeNotifications(getDb(env.DB), [{ recipientId: bob, kind: 'reply', billId: bill, commentId, actorId: alice, data: {} }])
    const res = await call('/notifications', { headers: { Cookie: `session=${await seedSession(bob)}` } })
    const row = ((await res.clone().json()) as { notifications: Array<Record<string, unknown>> }).notifications[0]
    expect(await bodyText(res)).not.toMatch(/subtitle/i)
    expect(row.authorTitle).toBe('Town Clerk')
  })

  it('a member with no title has a null title and no `subtitle`', async () => {
    const none = await seedUser({ name: 'Nobody', email: 'nobody@example.com' })
    const res = await call('/auth/me', { headers: { Cookie: `session=${await seedSession(none)}` } })
    const me = (await res.clone().json()) as Record<string, unknown>
    expect(me.title).toBeNull()
    expect(await bodyText(res)).not.toMatch(/subtitle/i)
  })
})
