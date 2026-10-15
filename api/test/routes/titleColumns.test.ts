import { describe, it, expect, beforeEach } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { stubFetch, resetDb, applyMigrations, seedUser, seedSession, seedBill, seedComment, seedRole, seedUserRole } from '../helpers'
import { getDb } from '../../src/db/client'
import { commentReactions, feedEvents } from '../../src/db/schema'
import { writeNotifications } from '../../src/lib/notifications'

// The rename of users.subtitle to users.title (#539) is two steps. Migration
// 0105 adds `title`, copies `subtitle` into it, and keeps `subtitle`. So the
// previous build, which reads and writes `subtitle`, still works if the deploy
// is rolled back, or while it is still serving during the deploy.
//
// This build therefore:
//   - WRITES both columns wherever it writes a member's title, and
//   - READS `title`, falling back to `subtitle` when `title` is null.
//
// The fallback covers a row only the previous build wrote: a member created, or
// given a first title, by the old build after the migration ran. It cannot
// cover an old build EDITING a title this build already wrote, since there is
// no telling which of two differing values is newer, so `title` wins. A
// backfill would copy once at migration time and miss the same rows.
//
// Remove all of this with the drop migration (a follow-up issue).

const call = (path: string, init: RequestInit = {}) => SELF.fetch(`http://localhost/api${path}`, init)

/** Both columns as stored. The raw query bypasses the schema, so it reads what the previous build would. */
const columns = (id: string) =>
  env.DB.prepare('SELECT title, subtitle FROM users WHERE id = ?').bind(id).first<{ title: string | null; subtitle: string | null }>()

/** A member as the previous build leaves one: only `subtitle` is set. */
async function seedLegacyUser(o: { name: string; email: string; role?: string; subtitle: string | null; title?: string | null }): Promise<string> {
  const id = crypto.randomUUID()
  await env.DB.prepare('INSERT INTO users (id, email, name, role, subtitle, title) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(id, o.email, o.name, o.role ?? 'member', o.subtitle, o.title ?? null).run()
  return id
}

beforeEach(async () => {
  await resetDb()
  // The first PATCH /users/me looks up central's superadmin allowlist (cached for the rest of the file),
  // and the network guard refuses a fetch no test stubbed. An empty allowlist: nobody here is a superadmin.
  stubFetch(url => (new URL(url).pathname === '/api/admin/superadmin/emails'
    ? new Response(JSON.stringify({ hashes: [] }), { status: 200 })
    : new Response('not found', { status: 404 })))
  await applyMigrations()
})

describe('writes: a row this build writes has the same value in title and subtitle', () => {
  let alice: string
  let cookie: string
  beforeEach(async () => {
    alice = await seedUser({ name: 'Alice', email: 'alice@example.com', role: 'admin' })
    cookie = `session=${await seedSession(alice)}`
  })
  const patch = (body: unknown) => call('/users/me', {
    method: 'PATCH',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

  it('PATCH /users/me with a title', async () => {
    expect((await patch({ title: 'Town Clerk' })).status).toBe(200)
    expect(await columns(alice)).toEqual({ title: 'Town Clerk', subtitle: 'Town Clerk' })
  })

  it('PATCH /users/me with the previous bundle\'s subtitle key', async () => {
    expect((await patch({ subtitle: 'County Clerk' })).status).toBe(200)
    expect(await columns(alice)).toEqual({ title: 'County Clerk', subtitle: 'County Clerk' })
  })

  it('PATCH /users/me trims the title in both columns', async () => {
    await patch({ title: '  Registrar  ' })
    expect(await columns(alice)).toEqual({ title: 'Registrar', subtitle: 'Registrar' })
  })

  it('PATCH /users/me with a blank or null title clears both', async () => {
    await patch({ title: 'Town Clerk' })
    await patch({ title: '   ' })
    expect(await columns(alice)).toEqual({ title: null, subtitle: null })
    await patch({ title: 'Town Clerk' })
    await patch({ title: null })
    expect(await columns(alice)).toEqual({ title: null, subtitle: null })
  })

  it('PATCH /users/me with a title that is too long or not a string writes neither', async () => {
    await patch({ title: 'Town Clerk' })
    expect((await patch({ title: 'x'.repeat(201) })).status).toBe(400)
    expect((await patch({ title: 42 })).status).toBe(400)
    expect(await columns(alice)).toEqual({ title: 'Town Clerk', subtitle: 'Town Clerk' })
  })

  it('PATCH /users/me with only other settings leaves both columns alone', async () => {
    await patch({ title: 'Town Clerk' })
    await patch({ name: 'Alice B', emailDigestEnabled: false })
    expect(await columns(alice)).toEqual({ title: 'Town Clerk', subtitle: 'Town Clerk' })
  })

  it('PATCH /users/me puts `title` ahead of `subtitle` when both are sent, in both columns', async () => {
    await patch({ title: 'New', subtitle: 'Old' })
    expect(await columns(alice)).toEqual({ title: 'New', subtitle: 'New' })
  })

  it('a member edit by an admin leaves both columns as they were', async () => {
    const bob = await seedUser({ name: 'Bob', email: 'bob@example.com', title: 'Analyst' })
    const res = await call(`/admin/members/${bob}`, {
      method: 'PATCH',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ canVote: false }),
    })
    expect(res.status).toBe(200)
    expect(await columns(bob)).toEqual({ title: 'Analyst', subtitle: 'Analyst' })
  })

  it('the test helper seeds both columns, like the code it stands in for', async () => {
    const id = await seedUser({ title: 'Seeded' })
    expect(await columns(id)).toEqual({ title: 'Seeded', subtitle: 'Seeded' })
    const none = await seedUser({})
    expect(await columns(none)).toEqual({ title: null, subtitle: null })
  })
})

describe('reads: a row only the previous build wrote is read correctly', () => {
  let legacy: string
  let cookie: string
  beforeEach(async () => {
    legacy = await seedLegacyUser({ name: 'Lee', email: 'lee@example.com', role: 'admin', subtitle: 'Written by the old build' })
    cookie = `session=${await seedSession(legacy)}`
  })
  const OLD = 'Written by the old build'

  it('GET /auth/me', async () => {
    const me = (await (await call('/auth/me', { headers: { Cookie: cookie } })).json()) as Record<string, unknown>
    expect([me.title, me.subtitle]).toEqual([OLD, OLD])
  })

  it('GET /users', async () => {
    const me = ((await (await call('/users', { headers: { Cookie: cookie } })).json()) as Array<Record<string, unknown>>).find(u => u.id === legacy)!
    expect([me.title, me.subtitle]).toEqual([OLD, OLD])
  })

  it('GET /admin/members', async () => {
    const me = ((await (await call('/admin/members', { headers: { Cookie: cookie } })).json()) as Array<Record<string, unknown>>).find(u => u.id === legacy)!
    expect([me.title, me.subtitle]).toEqual([OLD, OLD])
  })

  it('GET /roles members', async () => {
    await seedUserRole(legacy, await seedRole('Elections Committee'))
    const member = ((await (await call('/roles', { headers: { Cookie: cookie } })).json()) as Array<{ members: Array<Record<string, unknown>> }>)[0].members[0]
    expect([member.title, member.subtitle]).toEqual([OLD, OLD])
  })

  it('a bill\'s comments and their reactors', async () => {
    const bill = await seedBill({ billNumber: 'HB 1' })
    const commentId = await seedComment(bill, legacy, '<p>hi</p>')
    await getDb(env.DB).insert(commentReactions).values({ id: crypto.randomUUID(), commentId, userId: legacy, emoji: '👍' })
    const body = (await (await call(`/bills/${bill}`, { headers: { Cookie: cookie } })).json()) as { comments: Array<Record<string, any>> }
    const c = body.comments[0]
    expect([c.userTitle, c.userSubtitle]).toEqual([OLD, OLD])
    expect([c.reactions[0].reactors[0].title, c.reactions[0].reactors[0].subtitle]).toEqual([OLD, OLD])
  })

  it('the comments list for a bill', async () => {
    const bill = await seedBill({ billNumber: 'HB 2' })
    const commentId = await seedComment(bill, legacy, '<p>hi</p>')
    await getDb(env.DB).insert(commentReactions).values({ id: crypto.randomUUID(), commentId, userId: legacy, emoji: '👍' })
    const rows = (await (await call(`/bills/${bill}/comments`, { headers: { Cookie: cookie } })).json()) as Array<Record<string, any>>
    expect([rows[0].userTitle, rows[0].userSubtitle]).toEqual([OLD, OLD])
    expect([rows[0].reactions[0].reactors[0].title, rows[0].reactions[0].reactors[0].subtitle]).toEqual([OLD, OLD])
  })

  it('GET /feed', async () => {
    const bill = await seedBill({ billNumber: 'HB 3' })
    await getDb(env.DB).insert(feedEvents).values({ id: crypto.randomUUID(), type: 'bill_added', billId: bill, userId: legacy, metadata: '{}', createdAt: '2026-01-01T09:00:00Z' })
    const event = ((await (await call('/feed', { headers: { Cookie: cookie } })).json()) as { events: Array<Record<string, unknown>> }).events[0]
    expect([event.userTitle, event.userSubtitle]).toEqual([OLD, OLD])
  })

  it('GET /notifications authors', async () => {
    const bill = await seedBill({ billNumber: 'HB 4' })
    const bob = await seedUser({ name: 'Bob', email: 'bob@example.com' })
    const commentId = await seedComment(bill, legacy, '<p>a reply</p>')
    await writeNotifications(getDb(env.DB), [{ recipientId: bob, kind: 'reply', billId: bill, commentId, actorId: legacy, data: {} }])
    const row = ((await (await call('/notifications', { headers: { Cookie: `session=${await seedSession(bob)}` } })).json()) as { notifications: Array<Record<string, unknown>> }).notifications[0]
    expect([row.authorTitle, row.authorSubtitle]).toEqual([OLD, OLD])
  })

  it('a member with neither column set has no title', async () => {
    const none = await seedLegacyUser({ name: 'Nobody', email: 'nobody@example.com', subtitle: null })
    const me = (await (await call('/auth/me', { headers: { Cookie: `session=${await seedSession(none)}` } })).json()) as Record<string, unknown>
    expect([me.title, me.subtitle]).toEqual([null, null])
  })

  it('`title` wins over `subtitle` when both are set and differ', async () => {
    const both = await seedLegacyUser({ name: 'Both', email: 'both@example.com', subtitle: 'Stale', title: 'Current' })
    const me = (await (await call('/auth/me', { headers: { Cookie: `session=${await seedSession(both)}` } })).json()) as Record<string, unknown>
    expect([me.title, me.subtitle]).toEqual(['Current', 'Current'])
  })

  it('a title the new build then saves replaces the old build\'s in both columns', async () => {
    const res = await call('/users/me', {
      method: 'PATCH',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Saved by the new build' }),
    })
    expect(res.status).toBe(200)
    expect(await columns(legacy)).toEqual({ title: 'Saved by the new build', subtitle: 'Saved by the new build' })
  })
})
