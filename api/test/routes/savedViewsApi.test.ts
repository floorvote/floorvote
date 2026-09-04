import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { app } from '../../src/index'
import { resetDb, applyMigrations, seedUser, seedSession } from '../helpers'

describe('GET /api/views', () => {
  let adminCookie: string
  let memberCookie: string
  let adminId: string

  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    adminId = await seedUser({ role: 'admin', email: 'admin@example.com', name: 'Admin' })
    adminCookie = `session=${await seedSession(adminId)}`
    const memberId = await seedUser({ role: 'member', email: 'member@example.com', name: 'Member' })
    memberCookie = `session=${await seedSession(memberId)}`
  })

  it('returns 401 without a session cookie', async () => {
    const res = await app.request('/api/views', {}, env)
    expect(res.status).toBe(401)
  })

  it('returns an empty list when no views exist', async () => {
    const res = await app.request('/api/views', { headers: { Cookie: memberCookie } }, env)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ views: [] })
  })

  it('lets a member read views in display order', async () => {
    await env.DB.prepare(
      `INSERT INTO saved_views (id, name, query, created_by, display_order) VALUES
        ('v2', 'Auditor bills', 'subject=UT%3AAudits', ?, 1),
        ('v1', 'Clerk bills', 'subject=UT%3AElections', ?, 0)`,
    ).bind(adminId, adminId).run()

    const res = await app.request('/api/views', { headers: { Cookie: memberCookie } }, env)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      views: [
        { id: 'v1', name: 'Clerk bills', query: 'subject=UT%3AElections' },
        { id: 'v2', name: 'Auditor bills', query: 'subject=UT%3AAudits' },
      ],
    })
  })

  it('lets an admin/owner read views too — requireAuth is role-agnostic here, not accidentally admin-gated', async () => {
    await env.DB.prepare(
      `INSERT INTO saved_views (id, name, query, created_by, display_order) VALUES
        ('v1', 'Clerk bills', 'subject=UT%3AElections', ?, 0)`,
    ).bind(adminId).run()

    const res = await app.request('/api/views', { headers: { Cookie: adminCookie } }, env)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      views: [{ id: 'v1', name: 'Clerk bills', query: 'subject=UT%3AElections' }],
    })
  })
})
