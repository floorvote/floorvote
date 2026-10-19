import { describe, it, expect, vi, beforeEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { env } from 'cloudflare:test'
import { app } from '../../src/index'
import { clearDb, seedUser, seedSession, seedBill, seedRole, seedUserRole, mentionRecords } from '../helpers'
import { getDb } from '../../src/db/client'
import { notifications, feedEvents } from '../../src/db/schema'

// Edits go through the comments HTTP routes with the Cloudflare email binding
// stubbed, so "who got emailed" is read at the email-sending boundary. Mention
// emails are sent from waitUntil; the executionCtx below collects those promises
// so each request can be awaited to completion before asserting.
describe('editing a comment re-notifies only newly mentioned people', () => {
  let authorId: string
  let authorCookie: string
  let billId: string
  let send: ReturnType<typeof vi.fn>
  let pending: Promise<unknown>[]

  const ids: Record<string, string> = {}

  function testEnv() {
    return { ...env, EMAIL_PROVIDER: 'cloudflare', EMAIL: { send } }
  }

  async function request(path: string, method: 'POST' | 'PATCH', content: string, cookie = authorCookie) {
    const ctx = {
      waitUntil: (p: Promise<unknown>) => { pending.push(p) },
      passThroughOnException: () => {},
    } as unknown as ExecutionContext
    const res = await app.request(path, {
      method,
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    }, testEnv(), ctx)
    await Promise.all(pending.splice(0))
    return res
  }

  async function create(content: string) {
    const res = await request(`/api/bills/${billId}/comments`, 'POST', content)
    expect(res.status).toBe(201)
    const { id } = await res.json() as { id: string }
    send.mockClear()
    return id
  }

  async function edit(commentId: string, content: string) {
    const res = await request(`/api/comments/${commentId}`, 'PATCH', content)
    expect(res.status).toBe(200)
  }

  const user = (id: string, label: string) =>
    `<span data-type="mention" data-id="user:${id}" data-label="${label}">@${label}</span>`
  const role = (id: string, label: string) =>
    `<span data-type="mention" data-id="role:${id}" data-label="${label}">@${label}</span>`

  const emailedTo = () => send.mock.calls.map(call => (call[0] as { to: string[] }).to[0]).sort()

  async function mentionRows(commentId: string) {
    return mentionRecords(commentId)
  }

  async function makeMember(name: string, opts: { session?: boolean } = {}) {
    const id = await seedUser({ name, email: `${name.toLowerCase()}@example.com` })
    if (opts.session !== false) await seedSession(id)
    ids[name.toLowerCase()] = id
    return id
  }

  beforeEach(async () => {
    await clearDb()
    send = vi.fn(async () => ({ messageId: 'm-1' }))
    pending = []
    authorId = await seedUser({ role: 'admin', name: 'Admin', email: 'admin@example.com' })
    authorCookie = `session=${await seedSession(authorId)}`
    billId = await seedBill()
    await makeMember('Jane')
    await makeMember('Bob')
    await makeMember('Cara')
  })

  it('an edit that leaves mentions unchanged sends no email and keeps read state', async () => {
    const commentId = await create(`<p>${user(ids.jane, 'Jane')} and ${user(ids.bob, 'Bob')}</p>`)
    const before = await mentionRows(commentId)
    expect(before).toHaveLength(2)
    const janeRow = before.find(r => r.userId === ids.jane)!
    await getDb(env.DB).update(notifications)
      .set({ readAt: '2026-01-01 09:00:00' }).where(eq(notifications.id, janeRow.id))

    await edit(commentId, `<p>Fixed a typo: ${user(ids.jane, 'Jane')} and ${user(ids.bob, 'Bob')}</p>`)

    expect(send).not.toHaveBeenCalled()
    const after = await mentionRows(commentId)
    expect(after.map(r => r.id).sort()).toEqual(before.map(r => r.id).sort())
    expect(after.find(r => r.userId === ids.jane)!.readAt).toBe('2026-01-01 09:00:00')
    expect(after.find(r => r.userId === ids.bob)!.readAt).toBeNull()
  })

  it('adding a mention emails and records only the newly mentioned person', async () => {
    const commentId = await create(`<p>${user(ids.jane, 'Jane')}</p>`)
    const janeRow = (await mentionRows(commentId))[0]

    await edit(commentId, `<p>${user(ids.jane, 'Jane')} ${user(ids.bob, 'Bob')}</p>`)

    expect(emailedTo()).toEqual(['bob@example.com'])
    const after = await mentionRows(commentId)
    expect(after.map(r => r.userId).sort()).toEqual([ids.jane, ids.bob].sort())
    expect(after.find(r => r.userId === ids.jane)!.id).toBe(janeRow.id)
  })

  it('removing a mention deletes that person\'s record and sends nothing', async () => {
    const commentId = await create(`<p>${user(ids.jane, 'Jane')} ${user(ids.bob, 'Bob')}</p>`)

    await edit(commentId, `<p>${user(ids.jane, 'Jane')}</p>`)

    expect(send).not.toHaveBeenCalled()
    const after = await mentionRows(commentId)
    expect(after.map(r => r.userId)).toEqual([ids.jane])
  })

  it('removing every mention clears all of the comment\'s records', async () => {
    const commentId = await create(`<p>${user(ids.jane, 'Jane')}</p>`)

    await edit(commentId, '<p>No one mentioned now</p>')

    expect(send).not.toHaveBeenCalled()
    expect(await mentionRows(commentId)).toHaveLength(0)
  })

  it('a person already mentioned directly is not emailed again when a new role reaches them', async () => {
    const teamId = await seedRole('Team')
    await seedUserRole(ids.jane, teamId)
    await seedUserRole(ids.bob, teamId)
    const commentId = await create(`<p>${user(ids.jane, 'Jane')}</p>`)

    await edit(commentId, `<p>${user(ids.jane, 'Jane')} ${role(teamId, 'Team')}</p>`)

    // Jane was reached before the edit, so only Bob is newly reached through the role.
    expect(emailedTo()).toEqual(['bob@example.com'])
    const after = await mentionRows(commentId)
    expect(after.map(r => r.userId).sort()).toEqual([ids.jane, ids.bob].sort())
    // Jane keeps her original direct-mention record.
    expect(after.find(r => r.userId === ids.jane)!.sourceType).toBe('user')
    expect(after.find(r => r.userId === ids.bob)!.sourceType).toBe('role')
  })

  it('a person reached only through a newly added role is emailed once', async () => {
    const teamId = await seedRole('Team')
    await seedUserRole(ids.cara, teamId)
    const commentId = await create(`<p>${user(ids.jane, 'Jane')}</p>`)

    await edit(commentId, `<p>${user(ids.jane, 'Jane')} ${role(teamId, 'Team')}</p>`)

    expect(emailedTo()).toEqual(['cara@example.com'])
  })

  it('a role mention kept across an edit does not re-email its members', async () => {
    const teamId = await seedRole('Team')
    await seedUserRole(ids.jane, teamId)
    const commentId = await create(`<p>${role(teamId, 'Team')}</p>`)

    await edit(commentId, `<p>Reworded ${role(teamId, 'Team')}</p>`)

    expect(send).not.toHaveBeenCalled()
    expect(await mentionRows(commentId)).toHaveLength(1)
  })

  it('swapping the role that reaches a person keeps their record and does not re-email them', async () => {
    const teamA = await seedRole('Team A')
    const teamB = await seedRole('Team B')
    await seedUserRole(ids.jane, teamA)
    await seedUserRole(ids.jane, teamB)
    const commentId = await create(`<p>${role(teamA, 'Team A')}</p>`)
    const before = (await mentionRows(commentId))[0]

    await edit(commentId, `<p>${role(teamB, 'Team B')}</p>`)

    expect(send).not.toHaveBeenCalled()
    const after = await mentionRows(commentId)
    expect(after).toHaveLength(1)
    expect(after[0].id).toBe(before.id)
    // The record now points at the role that still reaches Jane.
    expect(after[0].sourceId).toBe(teamB)
  })

  it('people newly reached through @everyone skip members without a session', async () => {
    await makeMember('Pending', { session: false })
    const commentId = await create(`<p>${user(ids.jane, 'Jane')}</p>`)

    await edit(commentId, `<p>${user(ids.jane, 'Jane')} <span data-type="mention" data-id="everyone:all" data-label="everyone">@everyone</span></p>`)

    expect(emailedTo()).toEqual(['bob@example.com', 'cara@example.com'])
  })

  it('does not email anyone on edit when mention emails are disabled, but still records them', async () => {
    await env.DB.prepare("INSERT INTO association_config (key, value) VALUES ('mention_emails_enabled', 'false')").run()
    const commentId = await create(`<p>${user(ids.jane, 'Jane')}</p>`)

    await edit(commentId, `<p>${user(ids.jane, 'Jane')} ${user(ids.bob, 'Bob')}</p>`)

    expect(send).not.toHaveBeenCalled()
    expect((await mentionRows(commentId)).map(r => r.userId).sort()).toEqual([ids.jane, ids.bob].sort())
  })

  it('the feed event lists everyone currently mentioned, kept and new', async () => {
    const commentId = await create(`<p>${user(ids.jane, 'Jane')} ${user(ids.bob, 'Bob')}</p>`)

    await edit(commentId, `<p>${user(ids.jane, 'Jane')} ${user(ids.cara, 'Cara')}</p>`)

    const events = await getDb(env.DB).select().from(feedEvents).where(eq(feedEvents.type, 'comment_added')).all()
    expect(events).toHaveLength(1)
    const metadata = JSON.parse(events[0].metadata) as { mentionedUserIds: string[] }
    expect([...metadata.mentionedUserIds].sort()).toEqual([ids.jane, ids.cara].sort())
  })

  describe('an edit that leaves the mention tokens alone ignores membership changes since the comment was posted', () => {
    const everyone = '<span data-type="mention" data-id="everyone:all" data-label="everyone">@everyone</span>'

    it('a member who joined the mentioned role afterward is not emailed by a typo fix', async () => {
      const teamId = await seedRole('Team')
      await seedUserRole(ids.jane, teamId)
      const commentId = await create(`<p>Plese review ${role(teamId, 'Team')}</p>`)
      const before = await mentionRows(commentId)
      expect(before).toHaveLength(1)

      await seedUserRole(ids.bob, teamId)
      await edit(commentId, `<p>Please review ${role(teamId, 'Team')}</p>`)

      expect(send).not.toHaveBeenCalled()
      const after = await mentionRows(commentId)
      expect(after.map(r => r.id)).toEqual(before.map(r => r.id))
    })

    it('a member who left the mentioned role keeps their record through a typo fix', async () => {
      const teamId = await seedRole('Team')
      await seedUserRole(ids.jane, teamId)
      await seedUserRole(ids.bob, teamId)
      const commentId = await create(`<p>Plese review ${role(teamId, 'Team')}</p>`)
      const before = await mentionRows(commentId)
      expect(before).toHaveLength(2)

      await env.DB.prepare('DELETE FROM user_roles WHERE user_id = ? AND role_id = ?').bind(ids.bob, teamId).run()
      await edit(commentId, `<p>Please review ${role(teamId, 'Team')}</p>`)

      expect(send).not.toHaveBeenCalled()
      const after = await mentionRows(commentId)
      expect(after.map(r => r.id).sort()).toEqual(before.map(r => r.id).sort())
    })

    it('a member who lost their session keeps their @everyone record through a typo fix', async () => {
      const commentId = await create(`<p>Heads up ${everyone}</p>`)
      const before = await mentionRows(commentId)
      expect(before.map(r => r.userId).sort()).toEqual([ids.jane, ids.bob, ids.cara].sort())

      await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(ids.cara).run()
      await makeMember('Dana')
      await edit(commentId, `<p>Heads-up ${everyone}</p>`)

      expect(send).not.toHaveBeenCalled()
      const after = await mentionRows(commentId)
      expect(after.map(r => r.id).sort()).toEqual(before.map(r => r.id).sort())
    })

    it('adding a direct mention for someone reached only through a role flips their source to user without an email', async () => {
      const teamId = await seedRole('Team')
      await seedUserRole(ids.jane, teamId)
      const commentId = await create(`<p>${role(teamId, 'Team')}</p>`)
      const before = (await mentionRows(commentId))[0]
      expect(before.sourceType).toBe('role')
      await getDb(env.DB).update(notifications)
        .set({ readAt: '2026-01-01 09:00:00' }).where(eq(notifications.id, before.id))

      await edit(commentId, `<p>${role(teamId, 'Team')} ${user(ids.jane, 'Jane')}</p>`)

      expect(send).not.toHaveBeenCalled()
      const after = await mentionRows(commentId)
      expect(after).toHaveLength(1)
      expect(after[0].id).toBe(before.id)
      expect(after[0].sourceType).toBe('user')
      expect(after[0].sourceId).toBe(ids.jane)
      expect(after[0].readAt).toBe('2026-01-01 09:00:00')
    })
  })
})
