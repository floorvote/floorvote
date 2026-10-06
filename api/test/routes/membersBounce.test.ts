import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { app } from '../../src/index'
import { resetDb, applyMigrations, seedUser, seedSession, seedMagicLink, seedAuthEvent } from '../helpers'

type MemberRow = { id: string; email: string; emailBounce: { reason: string | null } | null }

const T1 = '2026-09-20 10:00:00'
const T2 = '2026-09-21 10:00:00'
const T3 = '2026-09-22 10:00:00'
const T4 = '2026-09-23 10:00:00'

async function sent(userId: string, messageId: string, createdAt: string, linkType: 'invite' | 'login' = 'invite') {
  await seedAuthEvent(userId, 'email_sent', { email: 'x@example.test', linkType, provider: 'cloudflare', messageId, createdAt })
}
async function bounced(userId: string, messageId: string, reason: string, createdAt: string, linkType: 'invite' | 'login' = 'invite') {
  await seedAuthEvent(userId, 'email_bounced', { email: 'x@example.test', linkType, provider: 'cloudflare', messageId, reason, createdAt })
}
async function delivered(userId: string, messageId: string, createdAt: string) {
  await seedAuthEvent(userId, 'email_delivered', { email: 'x@example.test', linkType: 'invite', provider: 'cloudflare', messageId, createdAt })
}

describe('GET /admin/members — emailBounce', () => {
  let adminId: string
  let cookie: string

  beforeEach(async () => {
    await resetDb(); await applyMigrations()
    adminId = await seedUser({ role: 'admin', email: 'admin@example.test' })
    cookie = `session=${await seedSession(adminId)}`
  })

  async function bounceOf(userId: string) {
    const res = await app.request('/api/admin/members', { headers: { Cookie: cookie } }, env)
    expect(res.status).toBe(200)
    const rows = await res.json() as MemberRow[]
    const row = rows.find(r => r.id === userId)
    expect(row).toBeDefined()
    expect(row).toHaveProperty('emailBounce')
    return row!.emailBounce
  }

  it('is null for every member when nothing bounced', async () => {
    const pending = await seedUser({ email: 'p@example.test', invitedBy: adminId })
    await sent(pending, 'm-1', T1)
    expect(await bounceOf(pending)).toBeNull()
    expect(await bounceOf(adminId)).toBeNull()
  })

  it('reports the reason when a pending invite\'s latest email bounced', async () => {
    const pending = await seedUser({ email: 'p@example.test', invitedBy: adminId })
    await sent(pending, 'm-1', T1)
    await bounced(pending, 'm-1', '550 5.1.1 user unknown', T2)
    expect(await bounceOf(pending)).toEqual({ reason: '550 5.1.1 user unknown' })
  })

  it('counts a bounced sign-in link the pending invite requested', async () => {
    const pending = await seedUser({ email: 'p@example.test', invitedBy: adminId })
    await sent(pending, 'm-inv', T1)
    await delivered(pending, 'm-inv', T2)
    await sent(pending, 'm-login', T3, 'login')
    await bounced(pending, 'm-login', 'mailbox full', T4, 'login')
    expect(await bounceOf(pending)).toEqual({ reason: 'mailbox full' })
  })

  it('reports a bounce recorded at send time (suppressed address, no message id)', async () => {
    const pending = await seedUser({ email: 'p@example.test', invitedBy: adminId })
    await sent(pending, 'm-1', T1)
    await seedAuthEvent(pending, 'email_bounced', {
      email: 'p@example.test', linkType: 'invite', provider: 'cloudflare',
      reason: 'E_RECIPIENT_SUPPRESSED', createdAt: T2,
    })
    expect(await bounceOf(pending)).toEqual({ reason: 'E_RECIPIENT_SUPPRESSED' })
  })

  it('clears once a newer email is sent, even while that email has no outcome yet', async () => {
    const pending = await seedUser({ email: 'p@example.test', invitedBy: adminId })
    await sent(pending, 'm-1', T1)
    await bounced(pending, 'm-1', 'user unknown', T2)
    await sent(pending, 'm-2', T3)
    expect(await bounceOf(pending)).toBeNull()
  })

  it('judges "latest" by send time, not by when the bounce was recorded', async () => {
    // Older email sent, newer email sent, then the hourly check records the
    // older one's bounce: the newer send is still the latest.
    const pending = await seedUser({ email: 'p@example.test', invitedBy: adminId })
    await sent(pending, 'm-old', T1)
    await sent(pending, 'm-new', T2)
    await bounced(pending, 'm-old', 'user unknown', T3)
    expect(await bounceOf(pending)).toBeNull()
  })

  it('stays clear when the newer email was delivered', async () => {
    const pending = await seedUser({ email: 'p@example.test', invitedBy: adminId })
    await sent(pending, 'm-1', T1)
    await bounced(pending, 'm-1', 'user unknown', T2)
    await sent(pending, 'm-2', T3)
    await delivered(pending, 'm-2', T4)
    expect(await bounceOf(pending)).toBeNull()
  })

  it('reports the bounce again when a resend bounces too, with the newest reason', async () => {
    const pending = await seedUser({ email: 'p@example.test', invitedBy: adminId })
    await sent(pending, 'm-1', T1)
    await bounced(pending, 'm-1', 'first reason', T2)
    await sent(pending, 'm-2', T3)
    await bounced(pending, 'm-2', 'second reason', T4)
    expect(await bounceOf(pending)).toEqual({ reason: 'second reason' })
  })

  it('ignores a later failed send attempt that never went out', async () => {
    const pending = await seedUser({ email: 'p@example.test', invitedBy: adminId })
    await sent(pending, 'm-1', T1)
    await bounced(pending, 'm-1', 'user unknown', T2)
    await seedAuthEvent(pending, 'email_send_failed', { email: 'p@example.test', linkType: 'invite', provider: 'cloudflare', reason: 'provider down', createdAt: T3 })
    expect(await bounceOf(pending)).toEqual({ reason: 'user unknown' })
  })

  it('is null for a member who has signed in, even if an email to them bounced', async () => {
    const member = await seedUser({ email: 'm@example.test', invitedBy: adminId })
    await seedMagicLink(member, { used: true })
    await sent(member, 'm-1', T1, 'login')
    await bounced(member, 'm-1', 'mailbox full', T2, 'login')
    expect(await bounceOf(member)).toBeNull()
  })

  it('is null for a deactivated member', async () => {
    const gone = await seedUser({ email: 'g@example.test', invitedBy: adminId, deactivatedAt: T4 })
    await sent(gone, 'm-1', T1)
    await bounced(gone, 'm-1', 'user unknown', T2)
    expect(await bounceOf(gone)).toBeNull()
  })

  it('keeps each member\'s bounce state separate', async () => {
    const a = await seedUser({ email: 'a@example.test', invitedBy: adminId })
    const b = await seedUser({ email: 'b@example.test', invitedBy: adminId })
    await sent(a, 'm-a', T1)
    await bounced(a, 'm-a', 'reason a', T2)
    await sent(b, 'm-b', T1)
    await delivered(b, 'm-b', T2)
    expect(await bounceOf(a)).toEqual({ reason: 'reason a' })
    expect(await bounceOf(b)).toBeNull()
  })
})
