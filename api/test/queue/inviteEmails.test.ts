import { describe, it, expect, vi, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { resetDb, applyMigrations, seedUser } from '../helpers'
import { getDb } from '../../src/db/client'
import { magicLinks, authEvents } from '../../src/db/schema'
import { eq } from 'drizzle-orm'
import { processInviteEmails } from '../../src/queue/inviteEmails'
import type { InviteEmailMessage } from '../../src/types'

const sendMagicLink = vi.fn()
vi.mock('../../src/lib/email', () => ({
  sendMagicLink: (...args: unknown[]) => sendMagicLink(...args),
}))

function msg(body: InviteEmailMessage) {
  return { body, ack: vi.fn(), retry: vi.fn() }
}

describe('processInviteEmails', () => {
  let userId: string
  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    userId = await seedUser({ role: 'member', email: 'jane@example.com', name: 'Jane' })
    sendMagicLink.mockReset()
  })

  it('mints a magic link and sends, then acks', async () => {
    sendMagicLink.mockResolvedValue(undefined)
    const m = msg({ type: 'invite-email', tenantId: env.TENANT_ID, userId, email: 'jane@example.com' })
    await processInviteEmails([m as any], env, getDb(env.DB))

    expect(sendMagicLink).toHaveBeenCalledOnce()
    const [to, url, , type] = sendMagicLink.mock.calls[0]
    expect(to).toBe('jane@example.com')
    expect(String(url)).toContain('/auth/verify?token=')
    expect(type).toBe('invite')

    const link = await getDb(env.DB).select().from(magicLinks).where(eq(magicLinks.userId, userId)).get()
    expect(link).toBeTruthy()
    expect(m.ack).toHaveBeenCalledOnce()
    expect(m.retry).not.toHaveBeenCalled()
  })

  it('passes the userId through to sendMagicLink so the email_sent event is attributable to the member', async () => {
    sendMagicLink.mockResolvedValue(undefined)
    const m = msg({ type: 'invite-email', tenantId: env.TENANT_ID, userId, email: 'jane@example.com' })
    await processInviteEmails([m as any], env, getDb(env.DB))

    // sendMagicLink(to, url, env, type, db, userId) — 6th positional arg carries the id.
    expect(sendMagicLink.mock.calls[0][5]).toBe(userId)
  })

  it('records an invite link_requested auth event attributed to the member', async () => {
    sendMagicLink.mockResolvedValue(undefined)
    const m = msg({ type: 'invite-email', tenantId: env.TENANT_ID, userId, email: 'jane@example.com' })
    await processInviteEmails([m as any], env, getDb(env.DB))

    const events = await getDb(env.DB).select().from(authEvents).where(eq(authEvents.userId, userId)).all()
    const invite = events.find(e => e.event === 'link_requested' && e.linkType === 'invite')
    expect(invite).toBeTruthy()
  })

  it('retries with a delay when the send fails', async () => {
    sendMagicLink.mockRejectedValue(new Error('Email send failed (resend): 429'))
    const m = msg({ type: 'invite-email', tenantId: env.TENANT_ID, userId, email: 'jane@example.com' })
    await processInviteEmails([m as any], env, getDb(env.DB))

    expect(m.retry).toHaveBeenCalledOnce()
    expect(m.retry.mock.calls[0][0]).toMatchObject({ delaySeconds: expect.any(Number) })
    expect(m.ack).not.toHaveBeenCalled()
  })

  it('acks and skips a message addressed to a different tenant', async () => {
    const m = msg({ type: 'invite-email', tenantId: 'some-other-tenant', userId, email: 'jane@example.com' })
    await processInviteEmails([m as any], env, getDb(env.DB))
    expect(sendMagicLink).not.toHaveBeenCalled()
    expect(m.ack).toHaveBeenCalledOnce()
  })
})
