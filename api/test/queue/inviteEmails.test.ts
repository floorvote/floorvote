import { describe, it, expect, vi, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { clearDb, seedUser } from '../helpers'
import { getDb } from '../../src/db/client'
import { magicLinks, authEvents } from '../../src/db/schema'
import { eq } from 'drizzle-orm'
import { processInviteEmails } from '../../src/queue/inviteEmails'
import type { InviteEmailMessage } from '../../src/types'
import { mail, resetMail, signInSent, linkIn } from '../mail'

vi.mock('../../src/lib/email', async (importOriginal) =>
  (await import('../mail')).withFakeSender(await importOriginal<typeof import('../../src/lib/email')>()))

function msg(body: InviteEmailMessage) {
  return { body, ack: vi.fn(), retry: vi.fn() }
}

describe('processInviteEmails', () => {
  let userId: string
  let errorSpy: ReturnType<typeof vi.spyOn>
  beforeEach(async () => {
    await clearDb()
    userId = await seedUser({ role: 'member', email: 'jane@example.com', name: 'Jane' })
    resetMail()
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  it('mints a magic link and sends it as a sign-in invite, then acks', async () => {
    const m = msg({ type: 'invite-email', tenantId: env.TENANT_ID, userId, email: 'jane@example.com' })
    await processInviteEmails([m as any], env, getDb(env.DB))

    expect(signInSent()).toHaveLength(1)
    const [sent] = signInSent()
    expect(sent).toMatchObject({ purpose: 'sign-in', link: 'invite', to: ['jane@example.com'] })
    expect(linkIn(sent)).toContain('/auth/verify?token=')

    const link = await getDb(env.DB).select().from(magicLinks).where(eq(magicLinks.userId, userId)).get()
    expect(link).toBeTruthy()
    expect(m.ack).toHaveBeenCalledOnce()
    expect(m.retry).not.toHaveBeenCalled()
  })

  it('attributes the sign-in event to the member, so the email_sent row shows in their Login activity', async () => {
    const m = msg({ type: 'invite-email', tenantId: env.TENANT_ID, userId, email: 'jane@example.com' })
    await processInviteEmails([m as any], env, getDb(env.DB))

    // The fake sender never calls the message's event writer, so call it as the real one would.
    await signInSent()[0].recordEvent!({ event: 'email_sent', provider: 'resend', reason: null, messageId: 'rs-1' })
    const events = await getDb(env.DB).select().from(authEvents).where(eq(authEvents.userId, userId)).all()
    expect(events.find(e => e.event === 'email_sent')).toMatchObject({ linkType: 'invite', email: 'jane@example.com', provider: 'resend', messageId: 'rs-1' })
  })

  it('sends through the API sender with the db, so each attempt is counted toward email health', async () => {
    const db = getDb(env.DB)
    await processInviteEmails([msg({ type: 'invite-email', tenantId: env.TENANT_ID, userId, email: 'jane@example.com' }) as any], env, db)
    const { senderFor } = await import('../mail')
    expect(senderFor).toHaveBeenCalledWith(env, db)
  })

  it('records an invite link_requested auth event attributed to the member', async () => {
    const m = msg({ type: 'invite-email', tenantId: env.TENANT_ID, userId, email: 'jane@example.com' })
    await processInviteEmails([m as any], env, getDb(env.DB))

    const events = await getDb(env.DB).select().from(authEvents).where(eq(authEvents.userId, userId)).all()
    const invite = events.find(e => e.event === 'link_requested' && e.linkType === 'invite')
    expect(invite).toBeTruthy()
  })

  it('retries with a delay when the send fails temporarily', async () => {
    mail.send.mockResolvedValue({ ok: false, provider: 'resend', error: '429', permanent: false, attempts: [] })
    const m = msg({ type: 'invite-email', tenantId: env.TENANT_ID, userId, email: 'jane@example.com' })
    await processInviteEmails([m as any], env, getDb(env.DB))

    expect(m.retry).toHaveBeenCalledOnce()
    expect(m.retry.mock.calls[0][0]).toMatchObject({ delaySeconds: expect.any(Number) })
    expect(m.ack).not.toHaveBeenCalled()
  })

  it('acks instead of retrying when the failure is permanent (a bad or suppressed address)', async () => {
    mail.send.mockResolvedValue({ ok: false, provider: null, error: 'Invalid recipient address: jane@example.gov;', permanent: true, attempts: [] })
    const m = msg({ type: 'invite-email', tenantId: env.TENANT_ID, userId, email: 'jane@example.gov;' })
    await processInviteEmails([m as any], env, getDb(env.DB))

    expect(m.ack).toHaveBeenCalledOnce()
    expect(m.retry).not.toHaveBeenCalled()
  })

  it('acks, and does not retry, when demo mode suppressed the invite: that is not a failure', async () => {
    mail.send.mockResolvedValue({ ok: true, provider: null, skipped: 'demo-mode', attempts: [] })
    const m = msg({ type: 'invite-email', tenantId: env.TENANT_ID, userId, email: 'jane@example.com' })
    await processInviteEmails([m as any], env, getDb(env.DB))

    expect(m.ack).toHaveBeenCalledOnce()
    expect(m.retry).not.toHaveBeenCalled()
  })

  it('logs why a send failed, naming the provider', async () => {
    mail.send.mockResolvedValue({ ok: false, provider: 'resend', error: '429', permanent: false, attempts: [] })
    await processInviteEmails([msg({ type: 'invite-email', tenantId: env.TENANT_ID, userId, email: 'jane@example.com' }) as any], env, getDb(env.DB))
    expect(errorSpy.mock.calls.map(c => c.map(String).join(' ')).join('\n')).toContain('Email send failed (resend): 429')
  })

  it('retries when the sender itself throws, as it did for any thrown failure', async () => {
    mail.send.mockRejectedValue(new Error('D1 unavailable'))
    const m = msg({ type: 'invite-email', tenantId: env.TENANT_ID, userId, email: 'jane@example.com' })
    await processInviteEmails([m as any], env, getDb(env.DB))

    expect(m.retry).toHaveBeenCalledOnce()
    expect(m.ack).not.toHaveBeenCalled()
  })

  it('acks and skips a message addressed to a different tenant', async () => {
    const m = msg({ type: 'invite-email', tenantId: 'some-other-tenant', userId, email: 'jane@example.com' })
    await processInviteEmails([m as any], env, getDb(env.DB))
    expect(mail.sent()).toHaveLength(0)
    expect(m.ack).toHaveBeenCalledOnce()
  })
})
