import { describe, it, expect, beforeEach } from 'vitest'
import { SELF } from 'cloudflare:test'
import { resetDb, applyMigrations, seedUser, seedSession, seedBill, seedRole, seedUserRole } from '../helpers'
import { getDb } from '../../src/db/client'
import { memberVotes, comments, notes, users, associationConfig } from '../../src/db/schema'
import { env } from 'cloudflare:test'
import { eq } from 'drizzle-orm'

const LAST_OWNER_ERROR = 'Transfer ownership before deactivating or deleting your account.'

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

  // A `name` key that's present and blank clears the stored name (stored as an
  // empty string). A missing `name` key means "no change", so saving only the
  // subtitle or the email settings never touches the name.
  describe('clearing the name', () => {
    async function patchMe(token: string, body: unknown) {
      return SELF.fetch('http://localhost/api/users/me', {
        method: 'PATCH',
        headers: { Cookie: `session=${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    }
    async function storedRow(id: string) {
      const db = getDb(env.DB)
      const [row] = await db.select({
        name: users.name, subtitle: users.subtitle,
        emailDigestEnabled: users.emailDigestEnabled, emailWeekAheadEnabled: users.emailWeekAheadEnabled,
      }).from(users).where(eq(users.id, id)).all()
      return row
    }

    it('clears the stored name for an empty-string name', async () => {
      const id = await seedUser({ name: 'Old Name' })
      const res = await patchMe(await seedSession(id), { name: '' })
      expect(res.status).toBe(200)
      expect((await storedRow(id)).name).toBe('')
    })

    it('clears the stored name for a whitespace-only name', async () => {
      const id = await seedUser({ name: 'Old Name' })
      const res = await patchMe(await seedSession(id), { name: ' \t  ' })
      expect(res.status).toBe(200)
      expect((await storedRow(id)).name).toBe('')
    })

    it('clears the stored name for a null name', async () => {
      const id = await seedUser({ name: 'Old Name' })
      const res = await patchMe(await seedSession(id), { name: null })
      expect(res.status).toBe(200)
      expect((await storedRow(id)).name).toBe('')
    })

    it('echoes the cleared name as an empty string', async () => {
      const id = await seedUser({ name: 'Old Name' })
      const res = await patchMe(await seedSession(id), { name: '   ' })
      expect(await res.json()).toMatchObject({ name: '' })
    })

    it('is a no-op success when clearing a name that is already blank', async () => {
      const id = await seedUser({ name: '' })
      const res = await patchMe(await seedSession(id), { name: '' })
      expect(res.status).toBe(200)
      expect((await storedRow(id)).name).toBe('')
    })

    it('clears the name and saves the subtitle sent with it', async () => {
      const id = await seedUser({ name: 'Old Name' })
      const res = await patchMe(await seedSession(id), { name: '', subtitle: 'New subtitle' })
      expect(res.status).toBe(200)
      expect(await res.json()).toMatchObject({ name: '', subtitle: 'New subtitle' })
      expect(await storedRow(id)).toMatchObject({ name: '', subtitle: 'New subtitle' })
    })

    it('a cleared name can be set again', async () => {
      const id = await seedUser({ name: 'Old Name' })
      const token = await seedSession(id)
      await patchMe(token, { name: '' })
      const res = await patchMe(token, { name: '  Fresh Name ' })
      expect(res.status).toBe(200)
      expect((await storedRow(id)).name).toBe('Fresh Name')
    })

    it('leaves the name unchanged on a subtitle-only save', async () => {
      const id = await seedUser({ name: 'Kept Name' })
      const res = await patchMe(await seedSession(id), { subtitle: 'Only subtitle' })
      expect(res.status).toBe(200)
      expect(await res.json()).not.toHaveProperty('name')
      expect(await storedRow(id)).toMatchObject({ name: 'Kept Name', subtitle: 'Only subtitle' })
    })

    it('leaves the name unchanged when the digest setting is saved', async () => {
      const id = await seedUser({ name: 'Kept Name' })
      const res = await patchMe(await seedSession(id), { emailDigestEnabled: false })
      expect(res.status).toBe(200)
      expect(await res.json()).not.toHaveProperty('name')
      expect(await storedRow(id)).toMatchObject({ name: 'Kept Name', emailDigestEnabled: 0 })
    })

    it('leaves the name unchanged when the week-ahead setting is saved', async () => {
      const id = await seedUser({ name: 'Kept Name' })
      const res = await patchMe(await seedSession(id), { emailWeekAheadEnabled: false })
      expect(res.status).toBe(200)
      expect(await storedRow(id)).toMatchObject({ name: 'Kept Name', emailWeekAheadEnabled: 0 })
    })

    // Same "missing key means no change" rule for the subtitle: an email-setting
    // toggle used to wipe the stored subtitle because it was always written.
    it('leaves the subtitle unchanged when only an email setting is saved', async () => {
      const id = await seedUser({ name: 'Kept Name', subtitle: 'Kept subtitle' })
      const token = await seedSession(id)
      await patchMe(token, { emailDigestEnabled: false })
      await patchMe(token, { emailWeekAheadEnabled: false })
      expect(await storedRow(id)).toMatchObject({ name: 'Kept Name', subtitle: 'Kept subtitle' })
    })

    it('leaves the subtitle unchanged on a name-only save', async () => {
      const id = await seedUser({ name: 'Old Name', subtitle: 'Kept subtitle' })
      await patchMe(await seedSession(id), { name: '' })
      expect(await storedRow(id)).toMatchObject({ name: '', subtitle: 'Kept subtitle' })
    })

    it('still clears the subtitle for a null or blank subtitle', async () => {
      const id = await seedUser({ subtitle: 'Old subtitle' })
      const token = await seedSession(id)
      await patchMe(token, { subtitle: null })
      expect((await storedRow(id)).subtitle).toBeNull()
      await patchMe(token, { subtitle: 'Again' })
      await patchMe(token, { subtitle: '  ' })
      expect((await storedRow(id)).subtitle).toBeNull()
    })

    it('leaves everything unchanged for an empty body', async () => {
      const id = await seedUser({ name: 'Kept Name', subtitle: 'Kept subtitle' })
      const res = await patchMe(await seedSession(id), {})
      expect(res.status).toBe(200)
      expect(await storedRow(id)).toMatchObject({ name: 'Kept Name', subtitle: 'Kept subtitle' })
    })

    it('saves a non-blank name trimmed', async () => {
      const id = await seedUser({ name: 'Old Name' })
      const res = await patchMe(await seedSession(id), { name: '  Trimmed Name  ' })
      expect(res.status).toBe(200)
      expect(await res.json()).toMatchObject({ name: 'Trimmed Name' })
      expect((await storedRow(id)).name).toBe('Trimmed Name')
    })

    it('applies the length limit after trimming', async () => {
      const id = await seedUser({ name: 'Old Name' })
      const token = await seedSession(id)
      const ok = await patchMe(token, { name: `  ${'a'.repeat(100)}  ` })
      expect(ok.status).toBe(200)
      const tooLong = await patchMe(token, { name: 'a'.repeat(101) })
      expect(tooLong.status).toBe(400)
      expect((await storedRow(id)).name).toBe('a'.repeat(100))
    })

    it('rejects a non-string name with 400 and keeps the stored one', async () => {
      const id = await seedUser({ name: 'Kept Name' })
      const res = await patchMe(await seedSession(id), { name: 42 })
      expect(res.status).toBe(400)
      expect((await storedRow(id)).name).toBe('Kept Name')
    })

    it('lists a cleared user in GET /users with a blank name and their email', async () => {
      const id = await seedUser({ name: 'Old Name', email: 'cleared@example.com' })
      const token = await seedSession(id)
      await patchMe(token, { name: '' })
      const res = await SELF.fetch('http://localhost/api/users', { headers: { Cookie: `session=${token}` } })
      const list = await res.json() as Array<{ id: string; name: string; email: string }>
      expect(list.find(u => u.id === id)).toMatchObject({ name: '', email: 'cleared@example.com' })
    })

    it('orders GET /users by the name as shown, so a cleared user sorts by email', async () => {
      const viewer = await seedUser({ name: 'Mid Name', email: 'viewer@example.com' })
      const token = await seedSession(viewer)
      await seedUser({ name: 'Zed Last', email: 'aaa@example.com' })
      const cleared = await seedUser({ name: 'Old Name', email: 'nnn@example.com' })
      await patchMe(await seedSession(cleared), { name: '' })
      const res = await SELF.fetch('http://localhost/api/users', { headers: { Cookie: `session=${token}` } })
      const shown = (await res.json() as Array<{ name: string; email: string }>).map(u => u.name || u.email)
      const pos = (label: string) => shown.indexOf(label)
      expect(pos('Mid Name')).toBeLessThan(pos('nnn@example.com'))
      expect(pos('nnn@example.com')).toBeLessThan(pos('Zed Last'))
    })
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

describe('DELETE /users/me — last-owner guard', () => {
  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    await getDb(env.DB).insert(associationConfig).values({ key: 'account_deletion_enabled', value: 'true' })
  })

  it('blocks the sole active owner with 409', async () => {
    const ownerId = await seedUser({ role: 'owner', email: 'owner@x.com' })
    const token = await seedSession(ownerId)
    const res = await SELF.fetch('http://localhost/api/users/me', {
      method: 'DELETE',
      headers: { Cookie: `session=${token}` },
    })
    expect(res.status).toBe(409)
    const body = await res.json() as Record<string, unknown>
    expect(body.error).toBe(LAST_OWNER_ERROR)
    const row = await getDb(env.DB).select().from(users).where(eq(users.id, ownerId)).get()
    expect(row).toBeDefined()
  })

  it('allows an owner to delete when a second active owner exists', async () => {
    const ownerId = await seedUser({ role: 'owner', email: 'owner1@x.com' })
    await seedUser({ role: 'owner', email: 'owner2@x.com' })
    const token = await seedSession(ownerId)
    const res = await SELF.fetch('http://localhost/api/users/me', {
      method: 'DELETE',
      headers: { Cookie: `session=${token}` },
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  it('blocks when the only peer owner is deactivated (deactivated peer does not rescue)', async () => {
    const ownerId = await seedUser({ role: 'owner', email: 'owner1@x.com' })
    await seedUser({ role: 'owner', email: 'owner2@x.com', deactivatedAt: new Date().toISOString() })
    const token = await seedSession(ownerId)
    const res = await SELF.fetch('http://localhost/api/users/me', {
      method: 'DELETE',
      headers: { Cookie: `session=${token}` },
    })
    expect(res.status).toBe(409)
    const body = await res.json() as Record<string, unknown>
    expect(body.error).toBe(LAST_OWNER_ERROR)
  })

  it('does not block a non-owner (member)', async () => {
    const memberId = await seedUser({ role: 'member', email: 'member@x.com' })
    const token = await seedSession(memberId)
    const res = await SELF.fetch('http://localhost/api/users/me', {
      method: 'DELETE',
      headers: { Cookie: `session=${token}` },
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })
})

describe('POST /users/me/deactivate — last-owner guard', () => {
  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
  })

  it('blocks the sole active owner with 409', async () => {
    const ownerId = await seedUser({ role: 'owner', email: 'owner@x.com' })
    const token = await seedSession(ownerId)
    const res = await SELF.fetch('http://localhost/api/users/me/deactivate', {
      method: 'POST',
      headers: { Cookie: `session=${token}` },
    })
    expect(res.status).toBe(409)
    const body = await res.json() as Record<string, unknown>
    expect(body.error).toBe(LAST_OWNER_ERROR)
    const row = await getDb(env.DB).select().from(users).where(eq(users.id, ownerId)).get()
    expect(row?.deactivatedAt).toBeNull()
  })

  it('allows an owner to deactivate when a second active owner exists', async () => {
    const ownerId = await seedUser({ role: 'owner', email: 'owner1@x.com' })
    await seedUser({ role: 'owner', email: 'owner2@x.com' })
    const token = await seedSession(ownerId)
    const res = await SELF.fetch('http://localhost/api/users/me/deactivate', {
      method: 'POST',
      headers: { Cookie: `session=${token}` },
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  it('blocks when the only peer owner is deactivated (deactivated peer does not rescue)', async () => {
    const ownerId = await seedUser({ role: 'owner', email: 'owner1@x.com' })
    await seedUser({ role: 'owner', email: 'owner2@x.com', deactivatedAt: new Date().toISOString() })
    const token = await seedSession(ownerId)
    const res = await SELF.fetch('http://localhost/api/users/me/deactivate', {
      method: 'POST',
      headers: { Cookie: `session=${token}` },
    })
    expect(res.status).toBe(409)
    const body = await res.json() as Record<string, unknown>
    expect(body.error).toBe(LAST_OWNER_ERROR)
  })

  it('does not block a non-owner (admin)', async () => {
    const adminId = await seedUser({ role: 'admin', email: 'admin@x.com' })
    const token = await seedSession(adminId)
    const res = await SELF.fetch('http://localhost/api/users/me/deactivate', {
      method: 'POST',
      headers: { Cookie: `session=${token}` },
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })
})
