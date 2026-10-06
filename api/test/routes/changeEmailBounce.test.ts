import { describe, it, expect, vi, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { app } from '../../src/index'
import { resetDb, applyMigrations, seedUser, seedSession, seedAuthEvent } from '../helpers'

vi.mock('../../src/lib/centralFetch', () => ({
  centralFetch: vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }),
}))
vi.mock('../../src/cron/sync', () => ({ registerWithCentral: vi.fn().mockResolvedValue(undefined) }))

type MemberRow = { id: string; email: string; emailBounce: { reason: string | null } | null }

const T1 = '2026-09-20 10:00:00'
const T2 = '2026-09-20 10:05:00'

// The real send path, through a stubbed Cloudflare binding, so the new
// invite's `email_sent` row is what the members list reads.
describe('change-email clears a bounced invite', () => {
  let adminId: string
  let cookie: string
  let pendingId: string
  let send: ReturnType<typeof vi.fn>

  function testEnv() {
    return {
      ...env,
      EMAIL_PROVIDER: 'cloudflare',
      EMAIL: { send },
      CENTRAL: { emailSuppression: vi.fn(async () => ({ suppressed: false })) } as unknown as Fetcher,
    }
  }

  async function memberRow(id: string): Promise<MemberRow> {
    const res = await app.request('/api/admin/members', { headers: { Cookie: cookie } }, testEnv())
    expect(res.status).toBe(200)
    const row = (await res.json() as MemberRow[]).find(r => r.id === id)
    expect(row).toBeDefined()
    return row!
  }

  beforeEach(async () => {
    await resetDb(); await applyMigrations()
    send = vi.fn(async () => ({ messageId: 'm-new' }))
    adminId = await seedUser({ role: 'admin', email: 'admin@example.test' })
    cookie = `session=${await seedSession(adminId)}`
    pendingId = await seedUser({ email: 'jane@exmaple.test', invitedBy: adminId })
    await seedAuthEvent(pendingId, 'email_sent', { email: 'jane@exmaple.test', linkType: 'invite', provider: 'cloudflare', messageId: 'm-old', createdAt: T1 })
    await seedAuthEvent(pendingId, 'email_bounced', { email: 'jane@exmaple.test', linkType: 'invite', provider: 'cloudflare', messageId: 'm-old', reason: '550 5.1.1 user unknown', createdAt: T2 })
  })

  it('shows the bounce before the change', async () => {
    expect((await memberRow(pendingId)).emailBounce).toEqual({ reason: '550 5.1.1 user unknown' })
  })

  it('the new invite\'s send clears emailBounce and the row shows the new address', async () => {
    const res = await app.request(`/api/admin/members/${pendingId}/change-email`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'jane@example.test' }),
    }, testEnv())
    expect(res.status).toBe(200)

    // The send runs after the response (waitUntil); wait for it to land.
    await vi.waitFor(async () => {
      const row = await env.DB.prepare(
        "SELECT 1 FROM auth_events WHERE user_id = ? AND event = 'email_sent' AND message_id = 'm-new'",
      ).bind(pendingId).first()
      expect(row).not.toBeNull()
    })
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ to: ['jane@example.test'] }))

    const row = await memberRow(pendingId)
    expect(row.email).toBe('jane@example.test')
    expect(row.emailBounce).toBeNull()
  })

})
