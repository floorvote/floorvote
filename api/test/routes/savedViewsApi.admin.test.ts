import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { app } from '../../src/index'
import { resetDb, applyMigrations, seedUser, seedSession } from '../helpers'

describe('/api/admin/views', () => {
  let adminCookie: string
  let memberCookie: string

  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    const adminId = await seedUser({ role: 'admin', email: 'admin@example.com', name: 'Admin' })
    adminCookie = `session=${await seedSession(adminId)}`
    const memberId = await seedUser({ role: 'member', email: 'member@example.com', name: 'Member' })
    memberCookie = `session=${await seedSession(memberId)}`
  })

  function post(cookie: string, body: unknown) {
    return app.request(
      '/api/admin/views',
      { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
      env,
    )
  }

  it('refuses a member with 403', async () => {
    const res = await post(memberCookie, { name: 'Clerk bills', query: 'subject=UT%3AElections' })
    expect(res.status).toBe(403)
  })

  it('creates a view and returns it', async () => {
    const res = await post(adminCookie, { name: 'Clerk bills', query: 'subject=UT%3AElections' })
    expect(res.status).toBe(201)
    const body = await res.json() as { id: string; name: string; query: string }
    expect(body.name).toBe('Clerk bills')
    expect(body.query).toBe('subject=UT%3AElections')
    expect(body.id).toBeTruthy()
  })

  it('rejects a blank name', async () => {
    const res = await post(adminCookie, { name: '   ', query: 'subject=UT%3AElections' })
    expect(res.status).toBe(400)
  })

  it('rejects a blank query', async () => {
    const res = await post(adminCookie, { name: 'Clerk bills', query: '' })
    expect(res.status).toBe(400)
  })

  it('appends display_order so creation order is stable', async () => {
    await post(adminCookie, { name: 'First', query: 'status=1' })
    await post(adminCookie, { name: 'Second', query: 'status=2' })
    const res = await app.request('/api/views', { headers: { Cookie: memberCookie } }, env)
    const { views } = await res.json() as { views: { name: string }[] }
    expect(views.map(v => v.name)).toEqual(['First', 'Second'])
  })

  it('renames a view without touching its query', async () => {
    const created = await (await post(adminCookie, { name: 'Clerk bills', query: 'subject=UT%3AElections' })).json() as { id: string }
    const res = await app.request(
      `/api/admin/views/${created.id}`,
      { method: 'PUT', headers: { Cookie: adminCookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'County clerk bills' }) },
      env,
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ name: 'County clerk bills', query: 'subject=UT%3AElections' })
  })

  it('404s renaming an unknown id', async () => {
    const res = await app.request(
      '/api/admin/views/nope',
      { method: 'PUT', headers: { Cookie: adminCookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'X' }) },
      env,
    )
    expect(res.status).toBe(404)
  })

  it('deletes a view', async () => {
    const created = await (await post(adminCookie, { name: 'Clerk bills', query: 'status=1' })).json() as { id: string }
    const del = await app.request(`/api/admin/views/${created.id}`, { method: 'DELETE', headers: { Cookie: adminCookie } }, env)
    expect(del.status).toBe(204)
    const res = await app.request('/api/views', { headers: { Cookie: memberCookie } }, env)
    expect(await res.json()).toEqual({ views: [] })
  })

  it('404s deleting an unknown id', async () => {
    const res = await app.request('/api/admin/views/nope', { method: 'DELETE', headers: { Cookie: adminCookie } }, env)
    expect(res.status).toBe(404)
  })
})
