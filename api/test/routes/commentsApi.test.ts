import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { SELF } from 'cloudflare:test'
import { resetDb, applyMigrations, seedUser, seedSession, seedBill } from '../helpers'
import { getDb } from '../../src/db/client'
import { comments, commentReactions, feedEvents } from '../../src/db/schema'
import { app } from '../../src/index'
import { DEMO_COMMENT_REACTION_CAP } from '../../src/routes/billsApi/engagementRoutes'
import { REACTION_EMOJIS } from '../../../shared/reactionEmojis'
import { eq } from 'drizzle-orm'

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

  // A reaction row from SOMEONE ELSE, i.e. the chip a member joins by clicking
  // it. Inserted straight into D1 so the seeding path can't be constrained by
  // the very validation under test.
  async function seedReaction(emoji: string) {
    const db = getDb(env.DB)
    const otherId = await seedUser()
    await db.insert(commentReactions).values({
      id: crypto.randomUUID(), commentId, userId: otherId, emoji, createdAt: new Date().toISOString(),
    })
  }

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

  // Was "exceeds 16 bytes". The byte cap moved to 64 so a family ZWJ sequence
  // (👨‍👩‍👧‍👦, 25 bytes) can be sent at all; 'a'.repeat(17) is now refused by the
  // character rule rather than the length rule, so this asserts the length rule
  // with something that is genuinely only emoji.
  it('returns 400 when emoji UTF-8 encoding exceeds the byte cap (SEC-C2)', async () => {
    const res = await SELF.fetch(`http://localhost/api/comments/${commentId}/reactions`, {
      method: 'POST',
      headers: { Cookie: `session=${memberToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ emoji: '😀'.repeat(17) }),
    })
    expect(res.status).toBe(400)
  })

  // The emoji column is attacker-controlled and the unique index is
  // (commentId, userId, emoji), so anything the checker lets through that
  // onConflictDoNothing won't collapse becomes another chip rendered beside the
  // comment. "Contains a pictograph" was not enough: "😀BUY-CRYPTO" is 15 bytes
  // and passed, which is ~12 characters of arbitrary text on a public demo.
  describe('emoji validation — emoji characters only, no smuggled text', () => {
    const react = (emoji: string) =>
      SELF.fetch(`http://localhost/api/comments/${commentId}/reactions`, {
        method: 'POST',
        headers: { Cookie: `session=${memberToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ emoji }),
      })

    // Multi-codepoint sequences must survive the CHARACTER rule: rejecting them
    // would break real reactions, which is how over-tight validation gets
    // reverted. Only ❤️/👍 are in the picker, so the rest are asserted on the
    // join path (a row already on the comment) — that isolates the character
    // rule from the allowlist rule, which the suites below cover.
    it.each([
      ['plain pictograph', '👍'],
      ['variation selector', '❤️'],
    ])('accepts %s from the picker', async (_label, emoji) => {
      expect((await react(emoji)).status).toBe(200)
    })

    it.each([
      ['skin-tone modifier', '👍🏽'],
      ['regional indicators (flag)', '🇺🇸'],
      ['ZWJ family sequence', '👨‍👩‍👧‍👦'],
      ['ZWJ + skin tone', '👩🏽‍🚀'],
      ['seeded reaction', '✅'],
    ])('accepts %s once present on the comment', async (_label, emoji) => {
      await seedReaction(emoji)
      expect((await react(emoji)).status).toBe(200)
    })

    it.each([
      ['text smuggled after a pictograph', '😀BUY-CRYPTO'],
      ['a single trailing letter', '😀a'],
      ['a trailing space', '😀 '],
      ['a trailing newline', '😀\n'],
      ['a combining accent', '😀́'],
      ['plain text', 'abc'],
      ['a lone ZWJ', '‍'],
      ['a lone skin-tone modifier', '🏽'],
    ])('rejects %s', async (_label, emoji) => {
      expect((await react(emoji)).status).toBe(400)
    })
  })

  // The character class alone still admits every emoji that exists (~4,000),
  // and each distinct one is another chip. The UI only ever offers eight, so a
  // NEW emoji must be one of those eight; anything else is only acceptable
  // because it is already on the comment (joining an existing chip), which is
  // what keeps the seeded ✅/👀/🎉/😕 reactions clickable.
  describe('picker allowlist, with a join exception', () => {
    const react = (emoji: string) =>
      SELF.fetch(`http://localhost/api/comments/${commentId}/reactions`, {
        method: 'POST',
        headers: { Cookie: `session=${memberToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ emoji }),
      })

    it.each(REACTION_EMOJIS.map(e => [e] as const))('accepts picker emoji %s on a comment with no reactions', async (emoji) => {
      expect((await react(emoji)).status).toBe(200)
    })

    it('rejects a non-picker emoji that is not already on the comment', async () => {
      const res = await react('🥑')
      expect(res.status).toBe(400)
      expect((await res.json() as { error: string }).error).toMatch(/emoji/i)
    })

    it('accepts a non-picker emoji once another user has reacted with it', async () => {
      await seedReaction('🥑')
      expect((await react('🥑')).status).toBe(200)
    })

    it.each(['✅', '👀', '🎉', '😕'])('joins seeded demo emoji %s already on the comment', async (emoji) => {
      await seedReaction(emoji)
      expect((await react(emoji)).status).toBe(200)
    })

    it.each(['✅', '👀', '🎉', '😕'])('rejects seeded demo emoji %s on a comment that does not carry it', async (emoji) => {
      expect((await react(emoji)).status).toBe(400)
    })

    it('does not count a soft-deleted row as present', async () => {
      await seedReaction('🥑')
      const db = getDb(env.DB)
      await db.update(commentReactions).set({ deletedAt: new Date().toISOString() })
        .where(eq(commentReactions.emoji, '🥑'))
      expect((await react('🥑')).status).toBe(400)
    })

    // The join exception must not become a laundering route for junk that a
    // tenant's table picked up BEFORE the character rule existed: the character
    // rule and byte cap run first, on every path, so an existing "😀BUY-CRYPTO"
    // row can never be amplified into more chips.
    it('still rejects legacy smuggled text even when a matching row exists', async () => {
      await seedReaction('😀BUY-CRYPTO')
      expect((await react('😀BUY-CRYPTO')).status).toBe(400)
    })

    it('still rejects an over-long value even when a matching row exists', async () => {
      const long = '😀'.repeat(17)
      await seedReaction(long)
      expect((await react(long)).status).toBe(400)
    })
  })
})

describe('POST /comments/:id/reactions — demo distinct-emoji cap', () => {
  let memberToken: string
  let commentId: string
  const demoEnv = { ...env, DEMO_MODE: 'true' }
  // 12 distinct, all valid, NONE of them in the picker — so the emoji reacted
  // with below can still be a new-to-the-comment picker emoji. (With the picker
  // allowlist in place, a new emoji has to be one of the eight; filling the cap
  // with picker emoji would leave nothing acceptable to test the cap with. See
  // the report: the cap is now near-unreachable in practice.)
  const TWELVE = ['✅', '👀', '🎉', '😕', '🚀', '🌊', '🥑', '🐟', '🌱', '⚓', '🏖️', '🧭']
  // In the picker, so it clears the allowlist, and absent from TWELVE, so it is
  // NEW to the comment — exactly the case the cap governs.
  const NEW_PICKER_EMOJI = '🔥'

  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    const memberId = await seedUser()
    memberToken = await seedSession(memberId)
    const billId = await seedBill()
    const db = getDb(env.DB)
    commentId = crypto.randomUUID()
    await db.insert(comments).values({
      id: commentId, billId, userId: memberId, content: 'Hello.', createdAt: new Date().toISOString(),
    })
  })

  // Reactions from a DIFFERENT user, so the cap is proven to count distinct
  // emojis on the comment rather than the caller's own rows.
  async function fillTo(n: number) {
    const db = getDb(env.DB)
    const otherId = await seedUser()
    await db.insert(commentReactions).values(
      TWELVE.slice(0, n).map(emoji => ({
        id: crypto.randomUUID(), commentId, userId: otherId, emoji, createdAt: new Date().toISOString(),
      })),
    )
  }

  const react = (emoji: string, testEnv: typeof env) =>
    app.request(`/api/comments/${commentId}/reactions`, {
      method: 'POST',
      headers: { Cookie: `session=${memberToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ emoji }),
    }, testEnv)

  it('accepts a new emoji below the cap', async () => {
    await fillTo(DEMO_COMMENT_REACTION_CAP - 1)
    expect((await react(NEW_PICKER_EMOJI, demoEnv)).status).toBe(200)
  })

  it('refuses a NEW emoji at the cap, permanently — 403, not 429', async () => {
    await fillTo(DEMO_COMMENT_REACTION_CAP)
    const res = await react(NEW_PICKER_EMOJI, demoEnv)
    expect(res.status).toBe(403)
    expect((await res.json() as { error: string }).error).toMatch(/reaction/i)
  })

  it('still lets an EXISTING emoji be toggled at the cap', async () => {
    // Otherwise reacting normally breaks the moment a comment gets popular.
    await fillTo(DEMO_COMMENT_REACTION_CAP)
    expect((await react(TWELVE[0], demoEnv)).status).toBe(200)
  })

  it('does not apply the cap when DEMO_MODE is unset', async () => {
    await fillTo(DEMO_COMMENT_REACTION_CAP)
    expect((await react(NEW_PICKER_EMOJI, env)).status).toBe(200)
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
