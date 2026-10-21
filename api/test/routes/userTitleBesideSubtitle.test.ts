import { describe, it, expect, beforeEach } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { clearDb, stubFetch, seedUser, seedSession, seedRole, seedUserRole } from '../helpers'
import { getDb } from '../../src/db/client'
import { users } from '../../src/db/schema'

// The deploy window (#564). A deploy applies migrations before it swaps the
// Worker, so this build meets a database that still has `users.subtitle` (the
// column is dropped by a later migration). It never names the column: it must
// run against it, and leave whatever it holds untouched.

const call = (path: string, init: RequestInit = {}) => SELF.fetch(`http://localhost/api${path}`, init)

const subtitleOf = async (id: string) =>
  (await env.DB.prepare('SELECT subtitle FROM users WHERE id = ?').bind(id).first<{ subtitle: string | null }>())?.subtitle

/** A member whose columns differ: `title` is what shows, `subtitle` is what an older build left behind. */
async function seedBoth(email: string, title: string | null, subtitle: string | null): Promise<string> {
  const id = crypto.randomUUID()
  await env.DB.prepare('INSERT INTO users (id, email, name, role, title, subtitle) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(id, email, 'Pat', 'admin', title, subtitle).run()
  return id
}

let pat: string
let cookie: string

beforeEach(async () => {
  await clearDb()
  stubFetch(url => (new URL(url).pathname === '/api/admin/superadmin/emails'
    ? new Response(JSON.stringify({ hashes: [] }), { status: 200 })
    : new Response('not found', { status: 404 })))
  pat = await seedBoth('pat@example.com', 'Current title', 'Left behind')
  cookie = `session=${await seedSession(pat)}`
})

describe('against a database that still has users.subtitle', () => {
  it('has the column, so the tests below exercise the deploy window', async () => {
    const columns = (await env.DB.prepare('PRAGMA table_info(users)').all<{ name: string }>()).results.map(c => c.name)
    expect(columns).toContain('subtitle')
  })

  it('answers GET /auth/me with the title, never the subtitle', async () => {
    const res = await call('/auth/me', { headers: { Cookie: cookie } })
    expect(res.status).toBe(200)
    const me = (await res.json()) as Record<string, unknown>
    expect(me.title).toBe('Current title')
    expect(JSON.stringify(me)).not.toMatch(/subtitle|Left behind/i)
  })

  it('does not fall back to a subtitle when a member has no title', async () => {
    const lone = await seedBoth('lone@example.com', null, 'Only here')
    const res = await call('/auth/me', { headers: { Cookie: `session=${await seedSession(lone)}` } })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { title: string | null }).title).toBeNull()
  })

  it('saves a title with PATCH /users/me and leaves the subtitle untouched', async () => {
    const res = await call('/users/me', {
      method: 'PATCH',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'New title' }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ title: 'New title' })
    expect(await env.DB.prepare('SELECT title FROM users WHERE id = ?').bind(pat).first()).toEqual({ title: 'New title' })
    expect(await subtitleOf(pat)).toBe('Left behind')
  })

  it('clears a title with PATCH /users/me and leaves the subtitle untouched', async () => {
    await call('/users/me', {
      method: 'PATCH',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '' }),
    })
    expect(await env.DB.prepare('SELECT title FROM users WHERE id = ?').bind(pat).first()).toEqual({ title: null })
    expect(await subtitleOf(pat)).toBe('Left behind')
  })

  it('lists members in GET /users, /admin/members, and /roles with no subtitle', async () => {
    await seedUserRole(pat, await seedRole('Elections Committee'))
    for (const path of ['/users', '/admin/members', '/roles']) {
      const res = await call(path, { headers: { Cookie: cookie } })
      expect(res.status, path).toBe(200)
      const text = JSON.stringify(await res.json())
      expect(text, path).toContain('Current title')
      expect(text, path).not.toMatch(/subtitle|Left behind/i)
    }
  })

  it('inserts a new member without naming the column, leaving subtitle null', async () => {
    const db = getDb(env.DB)
    await db.insert(users).values({ id: 'new-member', email: 'new@example.com', name: 'New', role: 'member' })
    const withTitle = await seedUser({ email: 'titled@example.com', title: 'Registrar' })
    expect(await subtitleOf('new-member')).toBeNull()
    expect(await subtitleOf(withTitle)).toBeNull()
    expect(await env.DB.prepare('SELECT title FROM users WHERE id = ?').bind(withTitle).first()).toEqual({ title: 'Registrar' })
  })

  it('leaves the subtitle of other members alone when one member is edited', async () => {
    const other = await seedBoth('other@example.com', 'Other title', 'Other left behind')
    await call('/users/me', {
      method: 'PATCH',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Pat B', title: 'Changed' }),
    })
    expect(await subtitleOf(other)).toBe('Other left behind')
  })
})
