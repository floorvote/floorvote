import { describe, it, expect, beforeEach } from 'vitest'
import { SELF } from 'cloudflare:test'
import { resetDb, applyMigrations, seedUser, seedSession, seedBill, seedRole, seedUserRole } from '../helpers'
import { getDb } from '../../src/db/client'
import { memberVotes, comments, notes, users } from '../../src/db/schema'
import { env } from 'cloudflare:test'
import { eq } from 'drizzle-orm'

describe('PATCH /users/me', () => {
  let memberToken: string

  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    const memberId = await seedUser({ name: 'Alice' })
    memberToken = await seedSession(memberId)
  })

  it('updates subtitle', async () => {
    const res = await SELF.fetch('http://localhost/api/users/me', {
      method: 'PATCH',
      headers: { Cookie: `session=${memberToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ subtitle: 'County Clerk, Ingham County' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body.subtitle).toBe('County Clerk, Ingham County')
  })

  it('clears subtitle when empty string', async () => {
    const res = await SELF.fetch('http://localhost/api/users/me', {
      method: 'PATCH',
      headers: { Cookie: `session=${memberToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ subtitle: '' }),
    })
    expect(res.status).toBe(200)
    expect((await res.json() as Record<string, unknown>).subtitle).toBeNull()
  })

  it('updates name when non-empty name is provided', async () => {
    const memberId = await seedUser({ name: 'Original Name' })
    const token = await seedSession(memberId)
    const res = await SELF.fetch('http://localhost/api/users/me', {
      method: 'PATCH',
      headers: { Cookie: `session=${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'New Name' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body.name).toBe('New Name')
    // confirm DB was updated
    const db = getDb(env.DB)
    const [row] = await db.select({ name: users.name }).from(users).where(eq(users.id, memberId)).all()
    expect(row.name).toBe('New Name')
  })

  it('does NOT change name when empty string is provided', async () => {
    const memberId = await seedUser({ name: 'Stays The Same' })
    const token = await seedSession(memberId)
    const res = await SELF.fetch('http://localhost/api/users/me', {
      method: 'PATCH',
      headers: { Cookie: `session=${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '' }),
    })
    expect(res.status).toBe(200)
    // confirm DB name is unchanged
    const db = getDb(env.DB)
    const [row] = await db.select({ name: users.name }).from(users).where(eq(users.id, memberId)).all()
    expect(row.name).toBe('Stays The Same')
  })

  it('rejects name > 100 characters with 400', async () => {
    const res = await SELF.fetch('http://localhost/api/users/me', {
      method: 'PATCH',
      headers: { Cookie: `session=${memberToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'a'.repeat(101) }),
    })
    expect(res.status).toBe(400)
  })

  it('accepts name exactly 100 characters with 200', async () => {
    const res = await SELF.fetch('http://localhost/api/users/me', {
      method: 'PATCH',
      headers: { Cookie: `session=${memberToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'a'.repeat(100) }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body.name).toBe('a'.repeat(100))
  })

  it('rejects subtitle > 200 characters with 400', async () => {
    const res = await SELF.fetch('http://localhost/api/users/me', {
      method: 'PATCH',
      headers: { Cookie: `session=${memberToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ subtitle: 'b'.repeat(201) }),
    })
    expect(res.status).toBe(400)
  })

  it('accepts subtitle exactly 200 characters with 200', async () => {
    const res = await SELF.fetch('http://localhost/api/users/me', {
      method: 'PATCH',
      headers: { Cookie: `session=${memberToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ subtitle: 'b'.repeat(200) }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body.subtitle).toBe('b'.repeat(200))
  })
})

describe('GET /users/me/bills', () => {
  let memberId: string
  let memberToken: string

  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    memberId = await seedUser()
    memberToken = await seedSession(memberId)
    const billId1 = await seedBill({ billNumber: 'HB 1', title: 'Bill One' })
    const billId2 = await seedBill({ billNumber: 'HB 2', title: 'Bill Two' })
    const db = getDb(env.DB)
    const now = new Date().toISOString()
    await db.insert(memberVotes).values({ id: crypto.randomUUID(), userId: memberId, billId: billId1, position: 'support', createdAt: now, updatedAt: now })
    await db.insert(comments).values({ id: crypto.randomUUID(), billId: billId2, userId: memberId, content: 'Note.', createdAt: now })
  })

  it('returns bills the user has interacted with', async () => {
    const res = await SELF.fetch('http://localhost/api/users/me/bills', {
      headers: { Cookie: `session=${memberToken}` },
    })
    expect(res.status).toBe(200)
    const body = await res.json() as unknown[]
    expect(body).toHaveLength(2)
    const first = body[0] as Record<string, unknown>
    expect(first).toHaveProperty('billNumber')
    expect(first).toHaveProperty('myVote')
    expect(first).toHaveProperty('position')
  })

  it('includes commentPreview — non-null when comment exists, null when none', async () => {
    const res = await SELF.fetch('http://localhost/api/users/me/bills', {
      headers: { Cookie: `session=${memberToken}` },
    })
    const body = await res.json() as Record<string, unknown>[]
    // billId2 has a comment ('Note.'), billId1 does not
    const withComment = body.find((b) => b.hasComment === true)
    const withoutComment = body.find((b) => b.hasComment === false)
    expect(withComment).toBeDefined()
    expect(withComment!.commentPreview).toBe('Note.')
    expect(withoutComment).toBeDefined()
    expect(withoutComment!.commentPreview).toBeNull()
  })

  it('includes notePreview — non-null when note exists, null when none', async () => {
    // Add a note to billId1 (the voted-on bill)
    const db = getDb(env.DB)
    const now = new Date().toISOString()
    // We need billId1 — find by querying votes
    const voteRows = await db.select({ billId: memberVotes.billId }).from(memberVotes).where(eq(memberVotes.userId, memberId)).all()
    const billId1 = voteRows[0].billId
    await db.insert(notes).values({ id: crypto.randomUUID(), userId: memberId, billId: billId1, content: 'My private note here.', createdAt: now, updatedAt: now })

    const res = await SELF.fetch('http://localhost/api/users/me/bills', {
      headers: { Cookie: `session=${memberToken}` },
    })
    const body = await res.json() as Record<string, unknown>[]
    const withNote = body.find((b) => b.hasNote === true)
    const withoutNote = body.find((b) => b.hasNote === false)
    expect(withNote).toBeDefined()
    expect(withNote!.notePreview).toBe('My private note here.')
    expect(withoutNote).toBeDefined()
    expect(withoutNote!.notePreview).toBeNull()
  })
})

describe('GET/PUT /bills/:id/note', () => {
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

  it('returns null when no note exists', async () => {
    const res = await SELF.fetch(`http://localhost/api/bills/${billId}/note`, {
      headers: { Cookie: `session=${memberToken}` },
    })
    expect(res.status).toBe(200)
    expect((await res.json() as Record<string, unknown>).content).toBeNull()
  })

  it('creates and retrieves a note', async () => {
    await SELF.fetch(`http://localhost/api/bills/${billId}/note`, {
      method: 'PUT',
      headers: { Cookie: `session=${memberToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'My private note.' }),
    })
    const res = await SELF.fetch(`http://localhost/api/bills/${billId}/note`, {
      headers: { Cookie: `session=${memberToken}` },
    })
    expect((await res.json() as Record<string, unknown>).content).toBe('My private note.')
  })

  it('updates an existing note on second PUT', async () => {
    await SELF.fetch(`http://localhost/api/bills/${billId}/note`, {
      method: 'PUT',
      headers: { Cookie: `session=${memberToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'First draft.' }),
    })
    const res = await SELF.fetch(`http://localhost/api/bills/${billId}/note`, {
      method: 'PUT',
      headers: { Cookie: `session=${memberToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'Updated.' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body.content).toBe('Updated.')
    // confirm only one note row exists
    const db = getDb(env.DB)
    const { notes: notesTable } = await import('../../src/db/schema')
    const rows = await db.select().from(notesTable).all()
    expect(rows).toHaveLength(1)
  })
})

describe('GET /users', () => {
  let memberId: string
  let memberCookie: string

  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    memberId = await seedUser({ role: 'member', email: 'member@example.com', name: 'Member User' })
    const memberToken = await seedSession(memberId)
    memberCookie = `session=${memberToken}`
  })

  it('includes roles for each user', async () => {
    const roleId = await seedRole('Finance')
    await seedUserRole(memberId, roleId)

    const res = await SELF.fetch('http://localhost/api/users', {
      headers: { cookie: memberCookie },
    })
    expect(res.status).toBe(200)
    const userList = await res.json() as Array<{ id: string; roles: { id: string; name: string }[] }>

    const member = userList.find(u => u.id === memberId)!
    expect(member.roles).toHaveLength(1)
    expect(member.roles[0]).toEqual({ id: roleId, name: 'Finance' })
  })
})

describe('GET /roles', () => {
  let memberCookie: string

  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    const memberId = await seedUser({ name: 'Alice', subtitle: 'Town Clerk' })
    const memberToken = await seedSession(memberId)
    memberCookie = `session=${memberToken}`

    const roleId = await seedRole('Elections Committee')
    await seedUserRole(memberId, roleId)
  })

  it('returns roles with members', async () => {
    const res = await SELF.fetch('http://localhost/api/roles', {
      headers: { cookie: memberCookie },
    })
    expect(res.status).toBe(200)
    const body = await res.json() as Array<{ id: string; name: string; members: Array<{ id: string; name: string; subtitle: string | null }> }>
    expect(body).toHaveLength(1)
    expect(body[0].name).toBe('Elections Committee')
    expect(body[0].members).toHaveLength(1)
    expect(body[0].members[0].name).toBe('Alice')
    expect(body[0].members[0].subtitle).toBe('Town Clerk')
  })

  it('returns empty array when no roles exist', async () => {
    await resetDb()
    await applyMigrations()
    const userId = await seedUser()
    const token = await seedSession(userId)
    const res = await SELF.fetch('http://localhost/api/roles', {
      headers: { cookie: `session=${token}` },
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
  })

  it('rejects unauthenticated requests', async () => {
    const res = await SELF.fetch('http://localhost/api/roles')
    expect(res.status).toBe(401)
  })
})
