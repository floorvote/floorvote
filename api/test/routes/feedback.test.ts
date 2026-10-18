import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { SELF, env } from 'cloudflare:test'
import { resetDb, applyMigrations, seedUser, seedSession } from '../helpers'
import { getDb } from '../../src/db/client'
import { emailSendStats, associationConfig } from '../../src/db/schema'

beforeEach(async () => {
  await resetDb()
  await applyMigrations()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('POST /feedback', () => {
  it('returns 401 without a session', async () => {
    const res = await SELF.fetch('http://localhost/api/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Hello' }),
    })
    expect(res.status).toBe(401)
  })

  it('returns 400 for empty message', async () => {
    const userId = await seedUser()
    const token = await seedSession(userId)

    const res = await SELF.fetch('http://localhost/api/feedback', {
      method: 'POST',
      headers: { Cookie: `session=${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '   ' }),
    })
    expect(res.status).toBe(400)
  })

  it('returns 400 for missing message', async () => {
    const userId = await seedUser()
    const token = await seedSession(userId)

    const res = await SELF.fetch('http://localhost/api/feedback', {
      method: 'POST',
      headers: { Cookie: `session=${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
  })

  it('returns 200 when Resend succeeds', async () => {
    const userId = await seedUser({ email: 'tester@example.com' })
    const token = await seedSession(userId)

    vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async () =>
      new Response('{"id":"mock-id"}', { status: 200 }),
    )

    const res = await SELF.fetch('http://localhost/api/feedback', {
      method: 'POST',
      headers: { Cookie: `session=${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Great tool!', pageUrl: 'http://localhost:5173/bills' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { ok: boolean }
    expect(body.ok).toBe(true)
  })

  it('is not counted toward email health: no email_send_stats row and no Resend usage reading (#709)', async () => {
    const userId = await seedUser({ email: 'tester@example.com' })
    const token = await seedSession(userId)

    vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async () =>
      new Response('{"id":"mock-id"}', { status: 200, headers: { 'x-resend-monthly-quota': '812', 'x-resend-daily-quota': '40' } }),
    )

    const res = await SELF.fetch('http://localhost/api/feedback', {
      method: 'POST',
      headers: { Cookie: `session=${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Great tool!' }),
    })
    expect(res.status).toBe(200)
    const db = getDb(env.DB)
    expect(await db.select().from(emailSendStats).all()).toEqual([])
    expect((await db.select().from(associationConfig).all()).filter(r => r.key.startsWith('resend_'))).toEqual([])
  })

  it('does not count a failed feedback send either (#709)', async () => {
    const userId = await seedUser()
    const token = await seedSession(userId)

    vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async () =>
      new Response('{"message":"invalid api key"}', { status: 401 }),
    )

    const res = await SELF.fetch('http://localhost/api/feedback', {
      method: 'POST',
      headers: { Cookie: `session=${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'This will fail' }),
    })
    expect(res.status).toBe(500)
    expect(await getDb(env.DB).select().from(emailSendStats).all()).toEqual([])
  })

  it('returns 500 when Resend fails', async () => {
    const userId = await seedUser()
    const token = await seedSession(userId)

    vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async () =>
      new Response('{"message":"invalid api key"}', { status: 401 }),
    )

    const res = await SELF.fetch('http://localhost/api/feedback', {
      method: 'POST',
      headers: { Cookie: `session=${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'This will fail' }),
    })
    expect(res.status).toBe(500)
  })

  it('returns 400 when message exceeds 20 KB (SEC-I4)', async () => {
    const userId = await seedUser()
    const token = await seedSession(userId)

    const res = await SELF.fetch('http://localhost/api/feedback', {
      method: 'POST',
      headers: { Cookie: `session=${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'a'.repeat(20_481) }),
    })
    expect(res.status).toBe(400)
  })

  it('returns 200 when message is exactly 20 KB (SEC-I4)', async () => {
    const userId = await seedUser({ email: 'tester@example.com' })
    const token = await seedSession(userId)

    vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async () =>
      new Response('{"id":"mock-id"}', { status: 200 }),
    )

    const res = await SELF.fetch('http://localhost/api/feedback', {
      method: 'POST',
      headers: { Cookie: `session=${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'a'.repeat(20_480) }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { ok: boolean }
    expect(body.ok).toBe(true)
  })
})
