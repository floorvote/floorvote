import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { env } from 'cloudflare:test'
import { and, eq, inArray } from 'drizzle-orm'
import { resetDb, applyMigrations, seedUser, seedAuthEvent, seedMagicLink } from '../helpers'
import { getDb } from '../../src/db/client'
import { authEvents } from '../../src/db/schema'
import { runInviteBounceCheck } from '../../src/lib/inviteBounces'

const NOW = new Date('2026-09-23T21:00:00Z')
const HOUR_AGO = '2026-09-23 20:00:00'
const SIX_DAYS_AGO = '2026-09-17 21:00:00'
const EXACTLY_7_DAYS_AGO = '2026-09-16 21:00:00'
const JUST_OVER_7_DAYS_AGO = '2026-09-16 20:59:59'

type Delivery = Record<string, { status: string; isSpam: boolean; errorCause?: string; datetime?: string }>

function centralEnv(lookup: (ids: string[], since: string) => Promise<unknown>) {
  const emailDeliveryStatus = vi.fn(lookup)
  return { e: { ...env, CENTRAL: { emailDeliveryStatus } } as never, emailDeliveryStatus }
}

function returning(delivery: Delivery) {
  return centralEnv(async () => delivery)
}

async function outcomes() {
  const db = getDb(env.DB)
  return db.select().from(authEvents)
    .where(inArray(authEvents.event, ['email_bounced', 'email_delivered'])).all()
}

async function seedPendingInvite(email: string, opts: { invitedBy?: string | null } = {}) {
  return seedUser({ email, invitedBy: opts.invitedBy ?? null })
}

async function seedSent(userId: string, email: string, messageId: string, opts: { linkType?: 'invite' | 'login'; createdAt?: string; provider?: string } = {}) {
  await seedAuthEvent(userId, 'email_sent', {
    email, linkType: opts.linkType ?? 'invite', provider: opts.provider ?? 'cloudflare',
    messageId, createdAt: opts.createdAt ?? HOUR_AGO,
  })
}

describe('runInviteBounceCheck', () => {
  let inviterId: string
  beforeEach(async () => {
    await resetDb(); await applyMigrations()
    inviterId = await seedUser({ role: 'admin', email: 'inviter@example.test' })
  })
  afterEach(() => { vi.restoreAllMocks() })

  it('records a final failure once as email_bounced with its reason and message id, and returns it', async () => {
    const memberId = await seedPendingInvite('typo@example.test', { invitedBy: inviterId })
    await seedSent(memberId, 'typo@example.test', 'm-1')
    const { e } = returning({ 'm-1': { status: 'deliveryFailed', isSpam: false, errorCause: '550 5.1.1 user unknown' } })

    const bounces = await runInviteBounceCheck(e, getDb(env.DB), NOW)

    expect(bounces).toEqual([{
      memberId, email: 'typo@example.test', reason: '550 5.1.1 user unknown', inviterId, messageId: 'm-1',
    }])
    const rows = await outcomes()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      event: 'email_bounced', userId: memberId, email: 'typo@example.test',
      reason: '550 5.1.1 user unknown', messageId: 'm-1', linkType: 'invite', provider: 'cloudflare',
    })
  })

  it('falls back to the provider status as the reason when no error cause is given', async () => {
    const memberId = await seedPendingInvite('a@example.test')
    await seedSent(memberId, 'a@example.test', 'm-1')
    const { e } = returning({ 'm-1': { status: 'deliveryFailed', isSpam: false } })

    const [bounce] = await runInviteBounceCheck(e, getDb(env.DB), NOW)

    expect(bounce.reason).toBe('deliveryFailed')
    expect(bounce.inviterId).toBeNull()
  })

  it('treats a rejected status as a bounce', async () => {
    const memberId = await seedPendingInvite('a@example.test')
    await seedSent(memberId, 'a@example.test', 'm-1')
    const { e } = returning({ 'm-1': { status: 'rejected', isSpam: false, errorCause: 'suppressed' } })

    const bounces = await runInviteBounceCheck(e, getDb(env.DB), NOW)

    expect(bounces.map(b => b.reason)).toEqual(['suppressed'])
    expect((await outcomes())[0].event).toBe('email_bounced')
  })

  it('records a delivery as email_delivered and returns no bounce', async () => {
    const memberId = await seedPendingInvite('ok@example.test')
    await seedSent(memberId, 'ok@example.test', 'm-1')
    const { e } = returning({ 'm-1': { status: 'delivered', isSpam: false } })

    expect(await runInviteBounceCheck(e, getDb(env.DB), NOW)).toEqual([])

    const rows = await outcomes()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ event: 'email_delivered', userId: memberId, messageId: 'm-1', reason: null })
  })

  it.each(['sent', 'deferred', 'queued', 'somethingNew'])('writes nothing while the status is %s', async (status) => {
    const memberId = await seedPendingInvite('slow@example.test')
    await seedSent(memberId, 'slow@example.test', 'm-1')
    const { e } = returning({ 'm-1': { status, isSpam: false } })

    expect(await runInviteBounceCheck(e, getDb(env.DB), NOW)).toEqual([])
    expect(await outcomes()).toHaveLength(0)
  })

  it('writes nothing for an email the lookup has no record of yet', async () => {
    const memberId = await seedPendingInvite('a@example.test')
    await seedSent(memberId, 'a@example.test', 'm-1')
    const { e } = returning({})

    expect(await runInviteBounceCheck(e, getDb(env.DB), NOW)).toEqual([])
    expect(await outcomes()).toHaveLength(0)
  })

  it('looks up an email sent exactly 7 days ago but not one sent just before that', async () => {
    const a = await seedPendingInvite('a@example.test')
    const b = await seedPendingInvite('b@example.test')
    await seedSent(a, 'a@example.test', 'm-edge', { createdAt: EXACTLY_7_DAYS_AGO })
    await seedSent(b, 'b@example.test', 'm-old', { createdAt: JUST_OVER_7_DAYS_AGO })
    const { e, emailDeliveryStatus } = returning({})

    await runInviteBounceCheck(e, getDb(env.DB), NOW)

    expect(emailDeliveryStatus).toHaveBeenCalledOnce()
    expect(emailDeliveryStatus.mock.calls[0][0]).toEqual(['m-edge'])
    // The lookup window covers the whole 7 days.
    expect(emailDeliveryStatus.mock.calls[0][1]).toBe('2026-09-16T21:00:00.000Z')
  })

  it('does not call central at all when nothing needs checking', async () => {
    const memberId = await seedPendingInvite('a@example.test')
    await seedSent(memberId, 'a@example.test', 'm-old', { createdAt: JUST_OVER_7_DAYS_AGO })
    const { e, emailDeliveryStatus } = returning({})

    expect(await runInviteBounceCheck(e, getDb(env.DB), NOW)).toEqual([])
    expect(emailDeliveryStatus).not.toHaveBeenCalled()
  })

  it('does not look up an email that already has a recorded bounce or delivery', async () => {
    const a = await seedPendingInvite('a@example.test')
    const b = await seedPendingInvite('b@example.test')
    const c = await seedPendingInvite('c@example.test')
    await seedSent(a, 'a@example.test', 'm-bounced')
    await seedAuthEvent(a, 'email_bounced', { email: 'a@example.test', messageId: 'm-bounced', linkType: 'invite' })
    await seedSent(b, 'b@example.test', 'm-delivered')
    await seedAuthEvent(b, 'email_delivered', { email: 'b@example.test', messageId: 'm-delivered', linkType: 'invite' })
    await seedSent(c, 'c@example.test', 'm-open')
    const { e, emailDeliveryStatus } = returning({})

    await runInviteBounceCheck(e, getDb(env.DB), NOW)

    expect(emailDeliveryStatus.mock.calls[0][0]).toEqual(['m-open'])
  })

  it('only checks members who have never signed in and are not deactivated', async () => {
    const pending = await seedPendingInvite('pending@example.test')
    const signedIn = await seedUser({ email: 'in@example.test' })
    await seedMagicLink(signedIn, { used: true })
    const deactivated = await seedUser({ email: 'gone@example.test', deactivatedAt: '2026-09-20 00:00:00' })
    await seedSent(pending, 'pending@example.test', 'm-pending')
    await seedSent(signedIn, 'in@example.test', 'm-in', { linkType: 'login' })
    await seedSent(deactivated, 'gone@example.test', 'm-gone')
    const { e, emailDeliveryStatus } = returning({
      'm-pending': { status: 'deliveryFailed', isSpam: false, errorCause: 'x' },
      'm-in': { status: 'deliveryFailed', isSpam: false, errorCause: 'x' },
      'm-gone': { status: 'deliveryFailed', isSpam: false, errorCause: 'x' },
    })

    const bounces = await runInviteBounceCheck(e, getDb(env.DB), NOW)

    expect(emailDeliveryStatus.mock.calls[0][0]).toEqual(['m-pending'])
    expect(bounces.map(b => b.memberId)).toEqual([pending])
    expect((await outcomes()).map(r => r.userId)).toEqual([pending])
  })

  it('counts a sign-in link the pending invite requested as well as an invite', async () => {
    const memberId = await seedPendingInvite('a@example.test', { invitedBy: inviterId })
    await seedSent(memberId, 'a@example.test', 'm-login', { linkType: 'login' })
    const { e } = returning({ 'm-login': { status: 'deliveryFailed', isSpam: false, errorCause: 'mailbox full' } })

    const bounces = await runInviteBounceCheck(e, getDb(env.DB), NOW)

    expect(bounces).toEqual([{ memberId, email: 'a@example.test', reason: 'mailbox full', inviterId, messageId: 'm-login' }])
    const [row] = await outcomes()
    expect(row.linkType).toBe('login')
  })

  it('ignores sends with no message id and sends through a provider with no delivery record', async () => {
    const memberId = await seedPendingInvite('a@example.test')
    await seedAuthEvent(memberId, 'email_sent', { email: 'a@example.test', linkType: 'invite', provider: 'cloudflare', createdAt: HOUR_AGO })
    await seedSent(memberId, 'a@example.test', 'rs-1', { provider: 'resend' })
    const { e, emailDeliveryStatus } = returning({})

    expect(await runInviteBounceCheck(e, getDb(env.DB), NOW)).toEqual([])
    expect(emailDeliveryStatus).not.toHaveBeenCalled()
  })

  it('records each of several sends to one member on its own, including an older bounce under a newer pending send', async () => {
    const memberId = await seedPendingInvite('a@example.test', { invitedBy: inviterId })
    await seedSent(memberId, 'a@example.test', 'm-old', { createdAt: SIX_DAYS_AGO })
    await seedSent(memberId, 'a@example.test', 'm-new', { createdAt: HOUR_AGO })
    const { e, emailDeliveryStatus } = returning({
      'm-old': { status: 'deliveryFailed', isSpam: false, errorCause: 'user unknown' },
      'm-new': { status: 'sent', isSpam: false },
    })

    const bounces = await runInviteBounceCheck(e, getDb(env.DB), NOW)

    expect([...emailDeliveryStatus.mock.calls[0][0]].sort()).toEqual(['m-new', 'm-old'])
    expect(bounces.map(b => b.messageId)).toEqual(['m-old'])
    const rows = await outcomes()
    expect(rows.map(r => [r.event, r.messageId])).toEqual([['email_bounced', 'm-old']])
  })

  it('returns bounces for several members in one run', async () => {
    const a = await seedPendingInvite('a@example.test', { invitedBy: inviterId })
    const b = await seedPendingInvite('b@example.test', { invitedBy: inviterId })
    const c = await seedPendingInvite('c@example.test', { invitedBy: inviterId })
    await seedSent(a, 'a@example.test', 'm-a')
    await seedSent(b, 'b@example.test', 'm-b')
    await seedSent(c, 'c@example.test', 'm-c')
    const { e } = returning({
      'm-a': { status: 'deliveryFailed', isSpam: false, errorCause: 'r-a' },
      'm-b': { status: 'delivered', isSpam: false },
      'm-c': { status: 'deliveryFailed', isSpam: false, errorCause: 'r-c' },
    })

    const bounces = await runInviteBounceCheck(e, getDb(env.DB), NOW)

    expect(bounces.map(x => [x.email, x.reason]).sort()).toEqual([['a@example.test', 'r-a'], ['c@example.test', 'r-c']])
  })

  it('records a bounce once across two consecutive runs and does not look it up again', async () => {
    const memberId = await seedPendingInvite('a@example.test')
    await seedSent(memberId, 'a@example.test', 'm-1')
    const { e, emailDeliveryStatus } = returning({ 'm-1': { status: 'deliveryFailed', isSpam: false, errorCause: 'x' } })
    const db = getDb(env.DB)

    expect(await runInviteBounceCheck(e, db, NOW)).toHaveLength(1)
    expect(await runInviteBounceCheck(e, db, new Date(NOW.getTime() + 3600_000))).toEqual([])

    expect(emailDeliveryStatus).toHaveBeenCalledOnce()
    expect(await outcomes()).toHaveLength(1)
  })

  it('checks a still-in-progress email again on the next run and records it once it bounces', async () => {
    const memberId = await seedPendingInvite('a@example.test')
    await seedSent(memberId, 'a@example.test', 'm-1')
    const db = getDb(env.DB)
    const statuses: Delivery[] = [
      { 'm-1': { status: 'deferred', isSpam: false } },
      { 'm-1': { status: 'deliveryFailed', isSpam: false, errorCause: 'retries exhausted' } },
    ]
    const { e, emailDeliveryStatus } = centralEnv(async () => statuses.shift())

    expect(await runInviteBounceCheck(e, db, NOW)).toEqual([])
    const second = await runInviteBounceCheck(e, db, new Date(NOW.getTime() + 3600_000))

    expect(emailDeliveryStatus).toHaveBeenCalledTimes(2)
    expect(second.map(b => b.reason)).toEqual(['retries exhausted'])
  })

  it('writes nothing and does not throw when the lookup throws, so the next run retries', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const memberId = await seedPendingInvite('a@example.test')
    await seedSent(memberId, 'a@example.test', 'm-1')
    const { e } = centralEnv(async () => { throw new Error('central unavailable') })

    await expect(runInviteBounceCheck(e, getDb(env.DB), NOW)).resolves.toEqual([])
    expect(await outcomes()).toHaveLength(0)

    const retry = returning({ 'm-1': { status: 'deliveryFailed', isSpam: false, errorCause: 'x' } })
    expect(await runInviteBounceCheck(retry.e, getDb(env.DB), NOW)).toHaveLength(1)
  })

  it.each([
    ['{}', {}],
    ['null', null],
    ['undefined', undefined],
    ['a non-object', 'oops'],
  ])('writes nothing when the lookup returns %s', async (_label, value) => {
    const memberId = await seedPendingInvite('a@example.test')
    await seedSent(memberId, 'a@example.test', 'm-1')
    const { e } = centralEnv(async () => value)

    await expect(runInviteBounceCheck(e, getDb(env.DB), NOW)).resolves.toEqual([])
    expect(await outcomes()).toHaveLength(0)
  })

  it('writes nothing and does not throw when the central binding or the lookup method is missing', async () => {
    const memberId = await seedPendingInvite('a@example.test')
    await seedSent(memberId, 'a@example.test', 'm-1')
    const db = getDb(env.DB)

    await expect(runInviteBounceCheck({ ...env, CENTRAL: undefined } as never, db, NOW)).resolves.toEqual([])
    await expect(runInviteBounceCheck({ ...env, CENTRAL: {} } as never, db, NOW)).resolves.toEqual([])
    expect(await outcomes()).toHaveLength(0)
  })

  it('ignores statuses for message ids it did not ask about', async () => {
    const memberId = await seedPendingInvite('a@example.test')
    await seedSent(memberId, 'a@example.test', 'm-1')
    const { e } = returning({ 'm-other': { status: 'deliveryFailed', isSpam: false, errorCause: 'x' } })

    expect(await runInviteBounceCheck(e, getDb(env.DB), NOW)).toEqual([])
    expect(await outcomes()).toHaveLength(0)
  })

  it('records the outcome once when two sent rows share a message id', async () => {
    const memberId = await seedPendingInvite('a@example.test')
    await seedSent(memberId, 'a@example.test', 'm-1')
    await seedSent(memberId, 'a@example.test', 'm-1')
    const { e, emailDeliveryStatus } = returning({ 'm-1': { status: 'deliveryFailed', isSpam: false, errorCause: 'x' } })

    expect(await runInviteBounceCheck(e, getDb(env.DB), NOW)).toHaveLength(1)
    expect(emailDeliveryStatus.mock.calls[0][0]).toEqual(['m-1'])
    const db = getDb(env.DB)
    expect(await db.select().from(authEvents).where(and(eq(authEvents.event, 'email_bounced'), eq(authEvents.messageId, 'm-1'))).all()).toHaveLength(1)
  })
})
