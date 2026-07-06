import { describe, it, expect, beforeEach } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { getDb } from '../../src/db/client'
import { resetDb, applyMigrations, seedUser, seedSession, seedRole, seedUserRole } from '../helpers'
import { customFieldDefinitions } from '../../src/db/schema'
import { eq } from 'drizzle-orm'

describe('GET /admin/custom-fields', () => {
  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
  })

  it('returns pinned: false by default', async () => {
    const adminId = await seedUser({ role: 'owner' })
    const adminToken = await seedSession(adminId)

    const db = getDb(env.DB)
    const fieldId = crypto.randomUUID()
    await db.insert(customFieldDefinitions).values({
      id: fieldId,
      name: 'Fiscal Note',
      slug: 'fiscal_note',
      type: 'text',
      options: null,
      displayOrder: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })

    const res = await SELF.fetch('http://localhost/api/admin/custom-fields', {
      headers: { Cookie: `session=${adminToken}` },
    })
    expect(res.status).toBe(200)
    const fields = (await res.json()) as { id: string; pinned: boolean }[]
    expect(fields).toHaveLength(1)
    expect(fields[0].pinned).toBe(false)
  })

  it('returns pinned: true when set', async () => {
    const adminId = await seedUser({ role: 'owner' })
    const adminToken = await seedSession(adminId)

    const db = getDb(env.DB)
    const fieldId = crypto.randomUUID()
    await db.insert(customFieldDefinitions).values({
      id: fieldId,
      name: 'Budget Impact',
      slug: 'budget_impact',
      type: 'text',
      options: null,
      displayOrder: 0,
      pinned: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })

    const res = await SELF.fetch('http://localhost/api/admin/custom-fields', {
      headers: { Cookie: `session=${adminToken}` },
    })
    expect(res.status).toBe(200)
    const fields = (await res.json()) as { id: string; pinned: boolean }[]
    expect(fields).toHaveLength(1)
    expect(fields[0].pinned).toBe(true)
  })
})

describe('PUT /admin/custom-fields/:id (pinned)', () => {
  let adminToken: string
  let fieldId: string

  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    const adminId = await seedUser({ role: 'owner' })
    adminToken = await seedSession(adminId)

    const db = getDb(env.DB)
    fieldId = crypto.randomUUID()
    await db.insert(customFieldDefinitions).values({
      id: fieldId,
      name: 'Fiscal Note',
      slug: 'fiscal_note',
      type: 'text',
      options: null,
      displayOrder: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
  })

  it('sets pinned: true', async () => {
    const res = await SELF.fetch(
      `http://localhost/api/admin/custom-fields/${fieldId}`,
      {
        method: 'PUT',
        headers: {
          Cookie: `session=${adminToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ pinned: true }),
      },
    )
    expect(res.status).toBe(200)

    const db = getDb(env.DB)
    const row = await db
      .select({ pinned: customFieldDefinitions.pinned })
      .from(customFieldDefinitions)
      .where(eq(customFieldDefinitions.id, fieldId))
      .get()
    expect(row?.pinned).toBe(true)
  })

  it('sets pinned: false', async () => {
    const db = getDb(env.DB)
    await db
      .update(customFieldDefinitions)
      .set({ pinned: true })
      .where(eq(customFieldDefinitions.id, fieldId))

    const res = await SELF.fetch(
      `http://localhost/api/admin/custom-fields/${fieldId}`,
      {
        method: 'PUT',
        headers: {
          Cookie: `session=${adminToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ pinned: false }),
      },
    )
    expect(res.status).toBe(200)

    const row = await db
      .select({ pinned: customFieldDefinitions.pinned })
      .from(customFieldDefinitions)
      .where(eq(customFieldDefinitions.id, fieldId))
      .get()
    expect(row?.pinned).toBe(false)
  })

  it('non-admin cannot update pinned', async () => {
    const memberId = await seedUser({ role: 'member' })
    const memberToken = await seedSession(memberId)

    const res = await SELF.fetch(
      `http://localhost/api/admin/custom-fields/${fieldId}`,
      {
        method: 'PUT',
        headers: {
          Cookie: `session=${memberToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ pinned: true }),
      },
    )
    expect(res.status).toBe(403)
  })
})

describe('GET /config/custom-fields', () => {
  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
  })

  it('includes pinned field in response', async () => {
    const userId = await seedUser()
    const token = await seedSession(userId)

    const db = getDb(env.DB)
    const fieldId = crypto.randomUUID()
    await db.insert(customFieldDefinitions).values({
      id: fieldId,
      name: 'Committee Assignment',
      slug: 'committee_assignment',
      type: 'text',
      options: null,
      displayOrder: 0,
      pinned: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })

    const res = await SELF.fetch('http://localhost/api/config/custom-fields', {
      headers: { Cookie: `session=${token}` },
    })
    expect(res.status).toBe(200)
    const fields = (await res.json()) as { id: string; pinned: boolean }[]
    expect(fields).toHaveLength(1)
    expect(fields[0].pinned).toBe(true)
  })
})
