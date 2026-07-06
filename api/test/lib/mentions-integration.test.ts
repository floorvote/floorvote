import { describe, it, expect, beforeEach } from 'vitest'
import { SELF } from 'cloudflare:test'
import { resetDb, applyMigrations, seedUser, seedSession, seedBill, seedRole, seedUserRole } from '../helpers'
import { getDb } from '../../src/db/client'
import { commentMentions } from '../../src/db/schema'
import { env } from 'cloudflare:test'

describe('comment mention extraction (integration)', () => {
  let adminId: string
  let adminToken: string
  let mentionedUserId: string
  let billId: string

  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    adminId = await seedUser({ role: 'admin', name: 'Admin', email: 'admin@example.com' })
    adminToken = await seedSession(adminId)
    mentionedUserId = await seedUser({ name: 'Jane Smith', email: 'jane@example.com' })
    await seedSession(mentionedUserId)
    billId = await seedBill()
  })

  it('stores user mentions when posting a comment', async () => {
    const content = `<p>Hey <span data-type="mention" data-id="user:${mentionedUserId}" data-label="Jane Smith">@Jane Smith</span> check this</p>`
    const res = await SELF.fetch(`http://localhost/api/bills/${billId}/comments`, {
      method: 'POST',
      headers: { Cookie: `session=${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    })
    expect(res.status).toBe(201)
    const { id: commentId } = await res.json() as { id: string }

    const db = getDb(env.DB)
    const mentions = await db.select().from(commentMentions).all()
    expect(mentions).toHaveLength(1)
    expect(mentions[0].commentId).toBe(commentId)
    expect(mentions[0].userId).toBe(mentionedUserId)
    expect(mentions[0].sourceType).toBe('user')
    expect(mentions[0].sourceId).toBe(mentionedUserId)
  })

  it('resolves role mentions to individual users', async () => {
    const roleId = await seedRole('Finance')
    const user2 = await seedUser({ name: 'Bob', email: 'bob@example.com' })
    await seedSession(user2)
    await seedUserRole(mentionedUserId, roleId)
    await seedUserRole(user2, roleId)

    const content = `<p>Attention <span data-type="mention" data-id="role:${roleId}" data-label="Finance">@Finance</span></p>`
    const res = await SELF.fetch(`http://localhost/api/bills/${billId}/comments`, {
      method: 'POST',
      headers: { Cookie: `session=${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    })
    expect(res.status).toBe(201)

    const db = getDb(env.DB)
    const mentions = await db.select().from(commentMentions).all()
    expect(mentions).toHaveLength(2)
    expect(mentions.every(m => m.sourceType === 'role')).toBe(true)
    expect(mentions.every(m => m.sourceId === roleId)).toBe(true)
    const userIds = mentions.map(m => m.userId).sort()
    expect(userIds).toEqual([mentionedUserId, user2].sort())
  })

  it('does not store a mention for the comment author', async () => {
    const content = `<p>Talking to myself <span data-type="mention" data-id="user:${adminId}" data-label="Admin">@Admin</span></p>`
    const res = await SELF.fetch(`http://localhost/api/bills/${billId}/comments`, {
      method: 'POST',
      headers: { Cookie: `session=${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    })
    expect(res.status).toBe(201)

    const db = getDb(env.DB)
    const mentions = await db.select().from(commentMentions).all()
    expect(mentions).toHaveLength(0)
  })

  it('deduplicates user mentioned directly and via role', async () => {
    const roleId = await seedRole('Team')
    await seedUserRole(mentionedUserId, roleId)

    const content = `<p><span data-type="mention" data-id="user:${mentionedUserId}" data-label="Jane">@Jane</span> and <span data-type="mention" data-id="role:${roleId}" data-label="Team">@Team</span></p>`
    const res = await SELF.fetch(`http://localhost/api/bills/${billId}/comments`, {
      method: 'POST',
      headers: { Cookie: `session=${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    })
    expect(res.status).toBe(201)

    const db = getDb(env.DB)
    const mentions = await db.select().from(commentMentions).all()
    expect(mentions).toHaveLength(1)
    expect(mentions[0].userId).toBe(mentionedUserId)
  })

  it('admin @everyone notifies all users except the author', async () => {
    const u2 = await seedUser({ name: 'Bob', email: 'bob@example.com' })
    const u3 = await seedUser({ name: 'Cara', email: 'cara@example.com' })
    await seedSession(u2)
    await seedSession(u3)

    const content = `<p><span data-type="mention" data-id="everyone:all" data-label="everyone">@everyone</span> heads up</p>`
    const res = await SELF.fetch(`http://localhost/api/bills/${billId}/comments`, {
      method: 'POST',
      headers: { Cookie: `session=${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    })
    expect(res.status).toBe(201)

    const db = getDb(env.DB)
    const mentions = await db.select().from(commentMentions).all()
    // adminId is the author and is excluded; mentionedUserId, u2, u3 remain.
    expect(mentions).toHaveLength(3)
    expect(mentions.every(m => m.sourceType === 'everyone')).toBe(true)
    expect(mentions.every(m => m.sourceId === 'all')).toBe(true)
    expect(mentions.map(m => m.userId).sort()).toEqual([mentionedUserId, u2, u3].sort())
  })

  it('ignores @everyone from a non-admin author', async () => {
    const memberId = await seedUser({ role: 'member', name: 'Member', email: 'member@example.com' })
    const memberToken = await seedSession(memberId)
    await seedUser({ name: 'Bob', email: 'bob@example.com' })

    const content = `<p><span data-type="mention" data-id="everyone:all" data-label="everyone">@everyone</span></p>`
    const res = await SELF.fetch(`http://localhost/api/bills/${billId}/comments`, {
      method: 'POST',
      headers: { Cookie: `session=${memberToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    })
    expect(res.status).toBe(201)

    const db = getDb(env.DB)
    const mentions = await db.select().from(commentMentions).all()
    expect(mentions).toHaveLength(0)
  })

  it('a non-admin @everyone still processes their direct mentions', async () => {
    const memberId = await seedUser({ role: 'member', name: 'Member', email: 'member@example.com' })
    const memberToken = await seedSession(memberId)

    const content = `<p><span data-type="mention" data-id="everyone:all" data-label="everyone">@everyone</span> and <span data-type="mention" data-id="user:${mentionedUserId}" data-label="Jane">@Jane</span></p>`
    const res = await SELF.fetch(`http://localhost/api/bills/${billId}/comments`, {
      method: 'POST',
      headers: { Cookie: `session=${memberToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    })
    expect(res.status).toBe(201)

    const db = getDb(env.DB)
    const mentions = await db.select().from(commentMentions).all()
    expect(mentions).toHaveLength(1)
    expect(mentions[0].userId).toBe(mentionedUserId)
    expect(mentions[0].sourceType).toBe('user')
  })

  it('excludes invite-pending users (no session) from @everyone and @role fan-out', async () => {
    const pending = await seedUser({ name: 'Pending', email: 'pending@example.com' })
    // no seedSession → pending user
    const roleId = await seedRole('All')
    await seedUserRole(pending, roleId)

    // @everyone should not notify pending user
    const everyoneContent = `<p><span data-type="mention" data-id="everyone:all" data-label="everyone">@everyone</span></p>`
    const r1 = await SELF.fetch(`http://localhost/api/bills/${billId}/comments`, {
      method: 'POST',
      headers: { Cookie: `session=${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: everyoneContent }),
    })
    expect(r1.status).toBe(201)
    const db = getDb(env.DB)
    const everyoneMentions = await db.select().from(commentMentions).all()
    // Only mentionedUserId (has session); admin is author; pending has no session
    expect(everyoneMentions).toHaveLength(1)
    expect(everyoneMentions[0].userId).toBe(mentionedUserId)

    // @role should not notify pending user
    await db.delete(commentMentions)
    const roleContent = `<p><span data-type="mention" data-id="role:${roleId}" data-label="All">@All</span></p>`
    const r2 = await SELF.fetch(`http://localhost/api/bills/${billId}/comments`, {
      method: 'POST',
      headers: { Cookie: `session=${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: roleContent }),
    })
    expect(r2.status).toBe(201)
    const roleMentions = await db.select().from(commentMentions).all()
    expect(roleMentions).toHaveLength(0)
  })

  it('precedence: direct mention wins over everyone for the same user', async () => {
    const bob = await seedUser({ name: 'Bob', email: 'bob@example.com' })
    await seedSession(bob)

    const content = `<p><span data-type="mention" data-id="user:${mentionedUserId}" data-label="Jane">@Jane</span> <span data-type="mention" data-id="everyone:all" data-label="everyone">@everyone</span></p>`
    const res = await SELF.fetch(`http://localhost/api/bills/${billId}/comments`, {
      method: 'POST',
      headers: { Cookie: `session=${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    })
    expect(res.status).toBe(201)

    const db = getDb(env.DB)
    const mentions = await db.select().from(commentMentions).all()
    // Jane appears once as 'user'; Bob appears once as 'everyone'. Author (admin) excluded.
    const jane = mentions.filter(m => m.userId === mentionedUserId)
    expect(jane).toHaveLength(1)
    expect(jane[0].sourceType).toBe('user')
    expect(mentions).toHaveLength(2)
  })
})
