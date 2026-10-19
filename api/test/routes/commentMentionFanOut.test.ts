import { describe, it, expect, vi, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { app } from '../../src/index'
import { clearDb, seedUser, seedSession, seedBill } from '../helpers'

// D1 rejects a statement with more than 100 bound parameters. An @everyone on a
// larger instance turns into one parameter per member, both when the mention
// notifications are written and when the recipients are looked up for email,
// so both have to be split. Mention emails go out from waitUntil, where a
// failure would otherwise be silent, so the test awaits them.
describe('@everyone on an instance of more than 100 members', () => {
  it('notifies and emails every member', async () => {
    await clearDb()
    const send = vi.fn(async () => ({ messageId: 'm-1' }))
    const pending: Promise<unknown>[] = []
    const adminId = await seedUser({ role: 'admin', name: 'Admin', email: 'admin@example.com' })
    const adminCookie = `session=${await seedSession(adminId)}`
    const billId = await seedBill()

    const memberCount = 105
    const members: string[] = []
    for (let i = 0; i < memberCount; i++) {
      const id = await seedUser({ name: `Member ${i}`, email: `member${i}@example.com` })
      await seedSession(id)
      members.push(`member${i}@example.com`)
    }

    const ctx = {
      waitUntil: (p: Promise<unknown>) => { pending.push(p) },
      passThroughOnException: () => {},
    } as unknown as ExecutionContext
    const res = await app.request(`/api/bills/${billId}/comments`, {
      method: 'POST',
      headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '<p><span data-type="mention" data-id="everyone:all" data-label="everyone">@everyone</span> heads up</p>' }),
    }, { ...env, EMAIL_PROVIDER: 'cloudflare', EMAIL: { send } }, ctx)
    expect(res.status).toBe(201)
    await Promise.all(pending)

    const emailed = send.mock.calls.map(call => (call[0] as unknown as { to: string[] }).to[0]).sort()
    expect(emailed).toEqual([...members].sort())
  }, 60_000)
})
