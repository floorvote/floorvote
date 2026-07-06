import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { SELF } from 'cloudflare:test'
import { resetDb, applyMigrations, seedUser, seedSession, seedBill } from '../helpers'
import { getDb } from '../../src/db/client'
import { comments, commentReactions, feedEvents } from '../../src/db/schema'

async function postComment(billId: string, token: string, content = 'Test comment') {
  return SELF.fetch(`http://localhost/api/bills/${billId}/comments`, {
    method: 'POST',
    headers: { Cookie: `session=${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  })
}

describe('GET /bills/:id/comments', () => {
  let memberId: string
  let memberToken: string
  let billId: string
  let commentId: string

  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    memberId = await seedUser({ name: 'Alice', subtitle: 'Clerk' })
    memberToken = await seedSession(memberId)
    billId = await seedBill()
    const db = getDb(env.DB)
    commentId = crypto.randomUUID()
    await db.insert(comments).values({
      id: commentId,
      billId,
      userId: memberId,
      content: 'Great bill.',
      createdAt: '2026-01-01T10:00:00Z',
    })
    await db.insert(commentReactions).values({
      id: crypto.randomUUID(),
      commentId,
      userId: memberId,
      emoji: '👍',
      createdAt: '2026-01-01T10:01:00Z',
    })
  })

  it('returns comments with author info and reactions', async () => {
    const res = await SELF.fetch(`http://localhost/api/bills/${billId}/comments`, {
      headers: { Cookie: `session=${memberToken}` },
    })
    expect(res.status).toBe(200)
    const body = await res.json() as unknown[]
    expect(body).toHaveLength(1)
    const c = body[0] as Record<string, unknown>
    expect(c.content).toBe('Great bill.')
    expect(c.userName).toBe('Alice')
    expect(c.userSubtitle).toBe('Clerk')
    expect((c.reactions as unknown[])).toHaveLength(1)
    expect((c.reactions as Record<string, unknown>[])[0].emoji).toBe('👍')
    expect((c.reactions as Record<string, unknown>[])[0].userReacted).toBe(true)
  })
})

describe('POST /bills/:id/comments', () => {
  let memberId: string
  let memberToken: string
  let billId: string

  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    memberId = await seedUser()
    memberToken = await seedSession(memberId)
    billId = await seedBill()
  })

  it('creates a comment and writes feed event', async () => {
    const res = await postComment(billId, memberToken)
    expect(res.status).toBe(201)
    const body = await res.json() as Record<string, unknown>
    expect(body.content).toBe('Test comment')
    expect(typeof body.id).toBe('string')
    expect(typeof body.createdAt).toBe('string')
    const db = getDb(env.DB)
    const events = await db.select().from(feedEvents).all()
    expect(events.some((e) => e.type === 'comment_added' && e.billId === billId)).toBe(true)
  })

  it('rejects empty content', async () => {
    const res = await postComment(billId, memberToken, '')
    expect(res.status).toBe(400)
  })

  it('sanitizes stored comment HTML, stripping dangerous tags/attrs (H5)', async () => {
    const hostile = '<p>Hello <strong>there</strong></p><img src=x onerror="alert(1)"><script>alert(2)</script><a href="javascript:alert(3)">x</a><p onclick="x()">tail</p>'
    const res = await postComment(billId, memberToken, hostile)
    expect(res.status).toBe(201)
    const db = getDb(env.DB)
    const rows = await db.select().from(comments).all()
    const stored = rows[0].content
    // dangerous content gone
    expect(stored).not.toMatch(/<img/i)
    expect(stored).not.toMatch(/onerror/i)
    expect(stored).not.toMatch(/<script/i)
    expect(stored).not.toMatch(/onclick/i)
    expect(stored).not.toMatch(/javascript:/i)
    expect(stored).not.toContain('alert(1)')
    expect(stored).not.toContain('alert(2)')
    // legitimate markup survives
    expect(stored).toContain('<strong>there</strong>')
    expect(stored).toContain('<p>Hello')
  })

  it('preserves mention spans through sanitization (H5)', async () => {
    const memberId2 = await seedUser({ name: 'Jane', email: 'jane2@example.com' })
    await seedSession(memberId2)
    const content = `<p>Hi <span data-type="mention" data-id="user:${memberId2}" data-label="Jane">@Jane</span></p>`
    const res = await postComment(billId, memberToken, content)
    expect(res.status).toBe(201)
    const db = getDb(env.DB)
    const rows = await db.select().from(comments).all()
    const stored = rows[0].content
    expect(stored).toContain('data-type="mention"')
    expect(stored).toContain(`data-id="user:${memberId2}"`)
    expect(stored).toContain('data-label="Jane"')
  })
})

describe('PATCH /comments/:id (sanitization, H5)', () => {
  let memberId: string
  let memberToken: string
  let billId: string
  let commentId: string

  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    memberId = await seedUser()
    memberToken = await seedSession(memberId)
    billId = await seedBill()
    const res = await postComment(billId, memberToken, '<p>original</p>')
    const body = await res.json() as { id: string }
    commentId = body.id
  })

  it('sanitizes edited comment HTML on update', async () => {
    const hostile = '<p>edited <strong>bold</strong></p><img src=x onerror="alert(1)"><script>alert(2)</script>'
    const res = await SELF.fetch(`http://localhost/api/comments/${commentId}`, {
      method: 'PATCH',
      headers: { Cookie: `session=${memberToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: hostile }),
    })
    expect(res.status).toBe(200)
    const db = getDb(env.DB)
    const rows = await db.select().from(comments).all()
    const stored = rows[0].content
    expect(stored).not.toMatch(/<img/i)
    expect(stored).not.toMatch(/onerror/i)
    expect(stored).not.toMatch(/<script/i)
    expect(stored).not.toContain('alert(1)')
    expect(stored).toContain('<strong>bold</strong>')
  })
})

describe('POST /comments/:id/reactions', () => {
  let memberId: string
  let memberToken: string
  let commentId: string

  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    memberId = await seedUser()
    memberToken = await seedSession(memberId)
    const billId = await seedBill()
    const db = getDb(env.DB)
    commentId = crypto.randomUUID()
    await db.insert(comments).values({
      id: commentId,
      billId,
      userId: memberId,
      content: 'Hello.',
      createdAt: new Date().toISOString(),
    })
  })

  it('adds a reaction', async () => {
    const res = await SELF.fetch(`http://localhost/api/comments/${commentId}/reactions`, {
      method: 'POST',
      headers: { Cookie: `session=${memberToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ emoji: '👍' }),
    })
    expect(res.status).toBe(200)
  })

  it('is idempotent (duplicate reaction is ignored)', async () => {
    await SELF.fetch(`http://localhost/api/comments/${commentId}/reactions`, {
      method: 'POST',
      headers: { Cookie: `session=${memberToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ emoji: '👍' }),
    })
    const res = await SELF.fetch(`http://localhost/api/comments/${commentId}/reactions`, {
      method: 'POST',
      headers: { Cookie: `session=${memberToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ emoji: '👍' }),
    })
    expect(res.status).toBe(200)
    const db = getDb(env.DB)
    const rows = await db.select().from(commentReactions).all()
    expect(rows).toHaveLength(1)
  })

  it('returns 404 for a non-existent comment ID (SEC-C2)', async () => {
    const res = await SELF.fetch(`http://localhost/api/comments/${crypto.randomUUID()}/reactions`, {
      method: 'POST',
      headers: { Cookie: `session=${memberToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ emoji: '👍' }),
    })
    expect(res.status).toBe(404)
  })

  it('returns 400 when emoji UTF-8 encoding exceeds 16 bytes (SEC-C2)', async () => {
    const res = await SELF.fetch(`http://localhost/api/comments/${commentId}/reactions`, {
      method: 'POST',
      headers: { Cookie: `session=${memberToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ emoji: 'a'.repeat(17) }),
    })
    expect(res.status).toBe(400)
  })
})

describe('DELETE /comments/:id/reactions/:emoji', () => {
  let memberId: string
  let memberToken: string
  let commentId: string

  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    memberId = await seedUser()
    memberToken = await seedSession(memberId)
    const billId = await seedBill()
    const db = getDb(env.DB)
    commentId = crypto.randomUUID()
    await db.insert(comments).values({ id: commentId, billId, userId: memberId, content: 'Hi.', createdAt: new Date().toISOString() })
    await db.insert(commentReactions).values({ id: crypto.randomUUID(), commentId, userId: memberId, emoji: '👍', createdAt: new Date().toISOString() })
  })

  it('removes a reaction', async () => {
    const emoji = encodeURIComponent('👍')
    const res = await SELF.fetch(`http://localhost/api/comments/${commentId}/reactions/${emoji}`, {
      method: 'DELETE',
      headers: { Cookie: `session=${memberToken}` },
    })
    expect(res.status).toBe(204)
    const db = getDb(env.DB)
    const rows = await db.select().from(commentReactions).all()
    expect(rows).toHaveLength(0)
  })

  it('returns 400 for a malformed percent-encoded emoji in the path (SEC-M3)', async () => {
    const res = await SELF.fetch(
      `http://localhost/api/comments/${commentId}/reactions/%ZZ`,
      { method: 'DELETE', headers: { Cookie: `session=${memberToken}` } },
    )
    expect(res.status).toBe(400)
  })
})

describe('DELETE /comments/:id', () => {
  let memberId: string
  let memberToken: string
  let adminToken: string
  let billId: string
  let commentId: string

  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    memberId = await seedUser({ role: 'member' })
    memberToken = await seedSession(memberId)
    const adminId = await seedUser({ role: 'admin' })
    adminToken = await seedSession(adminId)
    billId = await seedBill()
    const db = getDb(env.DB)
    const res = await SELF.fetch(`http://localhost/api/bills/${billId}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `session=${memberToken}` },
      body: JSON.stringify({ content: 'My comment' }),
    })
    const body = await res.json() as { id: string }
    commentId = body.id
  })

  it('deletes own comment and returns 204', async () => {
    const res = await SELF.fetch(`http://localhost/api/comments/${commentId}`, {
      method: 'DELETE',
      headers: { Cookie: `session=${memberToken}` },
    })
    expect(res.status).toBe(204)
    const db = getDb(env.DB)
    const { comments } = await import('../../src/db/schema')
    const row = await db.select().from(comments).all()
    expect(row).toHaveLength(1)
    expect(row[0].deletedAt).not.toBeNull()
    expect(row[0].deletedBy).toBe(memberId)
  })

  it('suppresses the matching comment_added feed event', async () => {
    await SELF.fetch(`http://localhost/api/comments/${commentId}`, {
      method: 'DELETE',
      headers: { Cookie: `session=${memberToken}` },
    })
    const db = getDb(env.DB)
    const events = await db.select().from(feedEvents).all()
    const commentEvent = events.find((e) => e.type === 'comment_added')
    expect(commentEvent).toBeDefined()
    expect(commentEvent!.suppressed).toBe(true)
  })

  it('returns 403 when member tries to delete another member\'s comment', async () => {
    const otherId = await seedUser({ role: 'member', email: 'other@example.com' })
    const otherToken = await seedSession(otherId)
    const res = await SELF.fetch(`http://localhost/api/comments/${commentId}`, {
      method: 'DELETE',
      headers: { Cookie: `session=${otherToken}` },
    })
    expect(res.status).toBe(403)
  })

  it('allows admin to delete any comment', async () => {
    const res = await SELF.fetch(`http://localhost/api/comments/${commentId}`, {
      method: 'DELETE',
      headers: { Cookie: `session=${adminToken}` },
    })
    expect(res.status).toBe(204)
  })
})
