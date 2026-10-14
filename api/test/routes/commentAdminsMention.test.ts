import { describe, it, expect, vi, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { app } from '../../src/index'
import { resetDb, applyMigrations, seedUser, seedSession, seedBill, seedRole, seedUserRole, mentionRecords } from '../helpers'

// @admins reaches every current Admin and Owner. Posts go through the comments
// routes with the Cloudflare email binding stubbed, so "who got emailed" is read
// at the email-sending boundary. Mention emails go out from waitUntil; the
// executionCtx below collects those promises so each request can be awaited.
describe('@admins mention', () => {
  let billId: string
  let send: ReturnType<typeof vi.fn>
  let pending: Promise<unknown>[]
  const ids: Record<string, string> = {}
  const cookies: Record<string, string> = {}

  async function seed(name: string, role: 'member' | 'admin' | 'owner', opts: { deactivated?: boolean } = {}) {
    const id = await seedUser({
      name, role, email: `${name.toLowerCase()}@example.com`,
      deactivatedAt: opts.deactivated ? '2026-01-01 00:00:00' : null,
    })
    // A deactivated member keeps a session row here on purpose: the mention
    // must skip them because they are deactivated, not only because sessions
    // happen to be cleared on deactivation.
    cookies[name.toLowerCase()] = `session=${await seedSession(id)}`
    ids[name.toLowerCase()] = id
    return id
  }

  async function request(path: string, method: 'POST' | 'PATCH', content: string, cookie: string) {
    const ctx = {
      waitUntil: (p: Promise<unknown>) => { pending.push(p) },
      passThroughOnException: () => {},
    } as unknown as ExecutionContext
    const res = await app.request(path, {
      method,
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    }, { ...env, EMAIL_PROVIDER: 'cloudflare', EMAIL: { send } }, ctx)
    await Promise.all(pending.splice(0))
    return res
  }

  async function post(author: string, content: string) {
    const res = await request(`/api/bills/${billId}/comments`, 'POST', content, cookies[author])
    expect(res.status).toBe(201)
    return (await res.json() as { id: string }).id
  }

  const admins = '<span data-type="mention" data-id="admins:all" data-label="admins">@admins</span>'
  const user = (id: string, label: string) =>
    `<span data-type="mention" data-id="user:${id}" data-label="${label}">@${label}</span>`
  const emailedTo = () => send.mock.calls.map(call => (call[0] as { to: string[] }).to[0]).sort()

  beforeEach(async () => {
    await resetDb(); await applyMigrations()
    send = vi.fn(async () => ({ messageId: 'm-1' }))
    pending = []
    billId = await seedBill()
    await seed('Sam', 'member')
    await seed('Dana', 'admin')
    await seed('Olive', 'owner')
    await seed('Rex', 'admin', { deactivated: true })
    await seed('Pat', 'member')
  })

  it('a standard member notifies every current admin and owner, in the app and by email', async () => {
    const commentId = await post('sam', `<p>${admins} please prioritize this</p>`)

    const rows = await mentionRecords(commentId)
    expect(rows.map(r => r.userId).sort()).toEqual([ids.dana, ids.olive].sort())
    expect(rows.every(r => r.sourceType === 'admins')).toBe(true)
    expect(emailedTo()).toEqual(['dana@example.com', 'olive@example.com'])
  })

  it('skips deactivated admins and standard members', async () => {
    const commentId = await post('sam', `<p>${admins}</p>`)

    const reached = (await mentionRecords(commentId)).map(r => r.userId)
    expect(reached).toContain(ids.dana)
    expect(reached).not.toContain(ids.rex)
    expect(reached).not.toContain(ids.pat)
    expect(emailedTo()).not.toContain('rex@example.com')
  })

  it('does not notify an admin who posts @admins about themselves', async () => {
    const commentId = await post('dana', `<p>${admins}</p>`)

    expect((await mentionRecords(commentId)).map(r => r.userId)).toEqual([ids.olive])
    expect(emailedTo()).toEqual(['olive@example.com'])
  })

  it('notifies an admin once when mentioned directly and through @admins', async () => {
    const commentId = await post('sam', `<p>${user(ids.dana, 'Dana')} ${admins}</p>`)

    const rows = await mentionRecords(commentId)
    expect(rows.map(r => r.userId).sort()).toEqual([ids.dana, ids.olive].sort())
    // The direct mention wins for Dana; Olive is reached only through @admins.
    expect(rows.find(r => r.userId === ids.dana)!.sourceType).toBe('user')
    expect(rows.find(r => r.userId === ids.olive)!.sourceType).toBe('admins')
    expect(emailedTo()).toEqual(['dana@example.com', 'olive@example.com'])
  })

  it('notifies an admin once when reached through a role and @admins, attributing the role', async () => {
    const teamId = await seedRole('Team')
    await seedUserRole(ids.dana, teamId)
    const commentId = await post('sam', `<p><span data-type="mention" data-id="role:${teamId}" data-label="Team">@Team</span> ${admins}</p>`)

    const rows = await mentionRecords(commentId)
    expect(rows.map(r => r.userId).sort()).toEqual([ids.dana, ids.olive].sort())
    expect(rows.find(r => r.userId === ids.dana)!.sourceType).toBe('role')
    expect(emailedTo()).toEqual(['dana@example.com', 'olive@example.com'])
  })

  it('the email tells the recipient they were reached as an admin', async () => {
    await post('sam', `<p>${admins}</p>`)

    const html = (send.mock.calls[0][0] as { html: string }).html
    expect(html).toContain('@admins')
    expect(html).toContain("because you're an admin")
  })

  it('an edit that adds @admins notifies the admins, and removing it clears them', async () => {
    const commentId = await post('sam', '<p>Take a look</p>')
    expect(await mentionRecords(commentId)).toHaveLength(0)

    const added = await request(`/api/comments/${commentId}`, 'PATCH', `<p>Take a look ${admins}</p>`, cookies.sam)
    expect(added.status).toBe(200)
    expect((await mentionRecords(commentId)).map(r => r.userId).sort()).toEqual([ids.dana, ids.olive].sort())
    expect(emailedTo()).toEqual(['dana@example.com', 'olive@example.com'])

    send.mockClear()
    const removed = await request(`/api/comments/${commentId}`, 'PATCH', '<p>Take a look</p>', cookies.sam)
    expect(removed.status).toBe(200)
    expect(await mentionRecords(commentId)).toHaveLength(0)
    expect(send).not.toHaveBeenCalled()
  })
})
