import { describe, it, expect, beforeEach } from 'vitest'
import { SELF } from 'cloudflare:test'
import { resetDb, applyMigrations, seedUser, seedSession } from '../helpers'

describe('POST /api/calendar/regenerate-slug', () => {
  let adminId: string
  let adminToken: string
  let memberId: string
  let memberToken: string

  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    adminId = await seedUser({ email: 'admin@test.com', role: 'admin' })
    adminToken = await seedSession(adminId)
    memberId = await seedUser({ email: 'member@test.com', role: 'member' })
    memberToken = await seedSession(memberId)
  })

  it('unauthenticated request returns 401', async () => {
    const r = await SELF.fetch('http://localhost/api/calendar/regenerate-slug', { method: 'POST' })
    expect(r.status).toBe(401)
  })

  it('member (non-admin) request returns 403', async () => {
    const r = await SELF.fetch('http://localhost/api/calendar/regenerate-slug', {
      method: 'POST',
      headers: { Cookie: `session=${memberToken}` },
    })
    expect(r.status).toBe(403)
  })

  it('admin can regenerate slug and gets back valid URLs', async () => {
    const r = await SELF.fetch('http://localhost/api/calendar/regenerate-slug', {
      method: 'POST',
      headers: { Cookie: `session=${adminToken}` },
    })
    expect(r.status).toBe(200)
    const body = await r.json() as { slug: string; feedUrl: string; webcalUrl: string; googleUrl: string }
    expect(body.slug).toMatch(/^[a-z0-9]{16,}$/)
    expect(body.feedUrl).toContain(`/api/calendar/feed/${body.slug}.ics`)
    expect(body.webcalUrl.startsWith('webcal://')).toBe(true)
    expect(body.googleUrl).toContain('calendar.google.com')
  })

  it('old slug no longer works after regeneration — feed returns 404', async () => {
    // Get the initial slug via /info
    const infoR = await SELF.fetch('http://localhost/api/calendar/info', {
      headers: { Cookie: `session=${adminToken}` },
    })
    const { slug: oldSlug } = await infoR.json() as { slug: string }

    // Verify the old slug works before rotation
    const feedBefore = await SELF.fetch(`http://localhost/api/calendar/feed/${oldSlug}.ics`)
    expect(feedBefore.status).toBe(200)

    // Rotate the slug
    await SELF.fetch('http://localhost/api/calendar/regenerate-slug', {
      method: 'POST',
      headers: { Cookie: `session=${adminToken}` },
    })

    // Old slug now returns 404
    const feedAfter = await SELF.fetch(`http://localhost/api/calendar/feed/${oldSlug}.ics`)
    expect(feedAfter.status).toBe(404)
  })

  it('new slug from regenerate-slug works on the feed route', async () => {
    const r = await SELF.fetch('http://localhost/api/calendar/regenerate-slug', {
      method: 'POST',
      headers: { Cookie: `session=${adminToken}` },
    })
    const { slug: newSlug } = await r.json() as { slug: string }

    const feedR = await SELF.fetch(`http://localhost/api/calendar/feed/${newSlug}.ics`)
    expect(feedR.status).toBe(200)
    expect(feedR.headers.get('content-type')).toContain('text/calendar')
  })

  it('regenerating twice always uses the latest slug', async () => {
    // First rotation
    const r1 = await SELF.fetch('http://localhost/api/calendar/regenerate-slug', {
      method: 'POST',
      headers: { Cookie: `session=${adminToken}` },
    })
    const { slug: slug1 } = await r1.json() as { slug: string }

    // Second rotation
    const r2 = await SELF.fetch('http://localhost/api/calendar/regenerate-slug', {
      method: 'POST',
      headers: { Cookie: `session=${adminToken}` },
    })
    const { slug: slug2 } = await r2.json() as { slug: string }

    // Slugs should be different (with overwhelming probability)
    expect(slug2).not.toBe(slug1)

    // First slug no longer works
    expect((await SELF.fetch(`http://localhost/api/calendar/feed/${slug1}.ics`)).status).toBe(404)
    // Second slug works
    expect((await SELF.fetch(`http://localhost/api/calendar/feed/${slug2}.ics`)).status).toBe(200)
  })
})
