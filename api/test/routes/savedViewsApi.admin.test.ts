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
    const body = await res.json() as { id: string; name: string; query: string; slug: string }
    expect(body.name).toBe('Clerk bills')
    expect(body.query).toBe('subject=UT%3AElections')
    expect(body.id).toBeTruthy()
    expect(body.slug).toBe('clerk-bills')
  })

  it('gives a second view with the same name a distinct, suffixed slug', async () => {
    const first = await (await post(adminCookie, { name: 'Clerk bills', query: 'status=1' })).json() as { slug: string }
    const second = await (await post(adminCookie, { name: 'Clerk bills', query: 'status=2' })).json() as { slug: string }
    expect(first.slug).toBe('clerk-bills')
    expect(second.slug).toBe('clerk-bills-2')
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

  it('rejects a 121-character name on create', async () => {
    const longName = 'a'.repeat(121)
    const res = await post(adminCookie, { name: longName, query: 'status=1' })
    expect(res.status).toBe(400)
    const body = await res.json() as { error: string }
    expect(body.error).toContain('120 characters or fewer')
  })

  it('accepts a 120-character name on create', async () => {
    const maxName = 'a'.repeat(120)
    const res = await post(adminCookie, { name: maxName, query: 'status=1' })
    expect(res.status).toBe(201)
    const body = await res.json() as { name: string }
    expect(body.name).toBe(maxName)
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

  // Rename decision: the slug regenerates to match the new name (mirroring
  // customFieldsApi), but the slug it replaces is kept as `previousSlug` for
  // one generation of back-compat, so a bookmark taken under the old name
  // does not silently stop resolving. GET /api/views exposes previousSlug so
  // the frontend can match either.
  it('regenerates the slug on rename but keeps the old one resolvable as previousSlug', async () => {
    const created = await (await post(adminCookie, { name: 'Clerk bills', query: 'subject=UT%3AElections' })).json() as { id: string; slug: string }
    expect(created.slug).toBe('clerk-bills')

    const res = await app.request(
      `/api/admin/views/${created.id}`,
      { method: 'PUT', headers: { Cookie: adminCookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'County clerk bills' }) },
      env,
    )
    expect(res.status).toBe(200)
    const body = await res.json() as { slug: string }
    expect(body.slug).toBe('county-clerk-bills')

    const listRes = await app.request('/api/views', { headers: { Cookie: memberCookie } }, env)
    const { views } = await listRes.json() as { views: { id: string; slug: string; previousSlug: string | null }[] }
    const view = views.find(v => v.id === created.id)
    expect(view?.slug).toBe('county-clerk-bills')
    expect(view?.previousSlug).toBe('clerk-bills')
  })

  it('does not churn previousSlug on a no-op rename (same name re-submitted)', async () => {
    const created = await (await post(adminCookie, { name: 'Clerk bills', query: 'subject=UT%3AElections' })).json() as { id: string }
    const res = await app.request(
      `/api/admin/views/${created.id}`,
      { method: 'PUT', headers: { Cookie: adminCookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Clerk bills' }) },
      env,
    )
    const body = await res.json() as { slug: string }
    expect(body.slug).toBe('clerk-bills')

    const listRes = await app.request('/api/views', { headers: { Cookie: memberCookie } }, env)
    const { views } = await listRes.json() as { views: { previousSlug: string | null }[] }
    expect(views[0].previousSlug).toBeNull()
  })

  it('rejects a 121-character name on rename', async () => {
    const created = await (await post(adminCookie, { name: 'Clerk bills', query: 'subject=UT%3AElections' })).json() as { id: string }
    const longName = 'a'.repeat(121)
    const res = await app.request(
      `/api/admin/views/${created.id}`,
      { method: 'PUT', headers: { Cookie: adminCookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: longName }) },
      env,
    )
    expect(res.status).toBe(400)
    const body = await res.json() as { error: string }
    expect(body.error).toContain('120 characters or fewer')
  })

  it('accepts a 120-character name on rename', async () => {
    const created = await (await post(adminCookie, { name: 'Clerk bills', query: 'subject=UT%3AElections' })).json() as { id: string }
    const maxName = 'a'.repeat(120)
    const res = await app.request(
      `/api/admin/views/${created.id}`,
      { method: 'PUT', headers: { Cookie: adminCookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: maxName }) },
      env,
    )
    expect(res.status).toBe(200)
    const body = await res.json() as { name: string }
    expect(body.name).toBe(maxName)
  })

  it('still rejects a blank name on rename', async () => {
    const created = await (await post(adminCookie, { name: 'Clerk bills', query: 'subject=UT%3AElections' })).json() as { id: string }
    const res = await app.request(
      `/api/admin/views/${created.id}`,
      { method: 'PUT', headers: { Cookie: adminCookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '   ' }) },
      env,
    )
    expect(res.status).toBe(400)
    const body = await res.json() as { error: string }
    expect(body.error).toBe('name is required')
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

  describe('PUT /admin/views/reorder', () => {
    function reorder(cookie: string, order: unknown) {
      return app.request(
        '/api/admin/views/reorder',
        { method: 'PUT', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ order }) },
        env,
      )
    }

    it('sets display_order by array index', async () => {
      const first = await (await post(adminCookie, { name: 'First', query: 'status=1' })).json() as { id: string }
      const second = await (await post(adminCookie, { name: 'Second', query: 'status=2' })).json() as { id: string }
      const third = await (await post(adminCookie, { name: 'Third', query: 'status=3' })).json() as { id: string }

      const res = await reorder(adminCookie, [third.id, first.id, second.id])
      expect(res.status).toBe(200)

      const listRes = await app.request('/api/views', { headers: { Cookie: memberCookie } }, env)
      const { views } = await listRes.json() as { views: { id: string }[] }
      expect(views.map(v => v.id)).toEqual([third.id, first.id, second.id])
    })

    it('refuses a member with 403', async () => {
      const res = await reorder(memberCookie, ['v1', 'v2'])
      expect(res.status).toBe(403)
    })

    it('rejects a non-array body with 400', async () => {
      const res = await reorder(adminCookie, 'not-an-array')
      expect(res.status).toBe(400)
    })

    it('is reachable and not shadowed by PUT /:id', async () => {
      // A route-ordering regression would route this request to PUT /:id
      // instead, whose handler 404s on an id of "reorder". Assert directly
      // against that failure mode rather than just checking success.
      const res = await reorder(adminCookie, [])
      expect(res.status).not.toBe(404)
    })
  })
})
