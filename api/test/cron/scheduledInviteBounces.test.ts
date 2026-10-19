import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { env, createExecutionContext, createScheduledController, waitOnExecutionContext } from 'cloudflare:test'
import { eq } from 'drizzle-orm'
import { resetDb, applyMigrations, seedUser, seedAuthEvent } from '../helpers'
import { getDb } from '../../src/db/client'
import { associationConfig, authEvents, users } from '../../src/db/schema'
import { fakeBinding, stubResend, type BindingOutcomes } from '../../../shared/emailTestKit'

// The hourly scheduled run end to end: the real bounce check against a stubbed
// central delivery lookup, then the bounce notification through a fake
// Cloudflare send binding. The other hourly jobs are stubbed out so the only
// email sent is the bounce notification.
vi.mock('../../src/lib/healStalledAi', () => ({
  healStalledAiBills: vi.fn(async () => ({ queued: 0, cappedOut: 0, remaining: 0 })),
  HEAL_MAX_ATTEMPTS: 5,
}))
vi.mock('../../src/lib/emailHealthJob', () => ({ runEmailHealth: vi.fn(async () => 'none') }))

import worker from '../../src/index'

const NOW = Date.parse('2026-09-23T21:00:00Z')
const HOUR_AGO = '2026-09-23 20:00:00'
const APP = 'https://app.example.test'
const MEMBERS_URL = `${APP}/admin/members`

type Delivery = Record<string, { status: string; isSpam: boolean; errorCause?: string }>
type Sent = { to: string[]; subject: string; html: string; text: string }

function stubs(delivery: Delivery | (() => Promise<unknown>), outcomes: BindingOutcomes = 'ok') {
  const emailDeliveryStatus = vi.fn(typeof delivery === 'function' ? delivery : async () => delivery)
  const cf = fakeBinding(outcomes)
  const e = {
    ...env,
    APP_URL: APP,
    EMAIL_PROVIDER: 'cloudflare',
    EMAIL: cf.binding,
    EMAIL_FROM: 'notifications@example.test',
    CENTRAL: { emailDeliveryStatus },
  }
  return { e, cf, emailDeliveryStatus }
}

async function runHourly(e: unknown, scheduledTime = NOW) {
  const ctx = createExecutionContext()
  const controller = createScheduledController({ cron: '0 * * * *', scheduledTime })
  await worker.scheduled(controller as unknown as ScheduledEvent, e as never, ctx)
  await waitOnExecutionContext(ctx)
}

const sentTo = (cf: ReturnType<typeof stubs>['cf']) =>
  cf.sent.map(m => [m.to].flat().join(',')).sort()

const mailFor = (cf: ReturnType<typeof stubs>['cf'], to: string): Sent => {
  const hits = cf.sent.filter(m => [m.to].flat().includes(to))
  expect(hits).toHaveLength(1)
  return hits[0] as Sent
}

/** The CTA's href, decoded from the one link to Members in the email. */
function membersLink(html: string): string {
  const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map(m => m[1].replace(/&amp;/g, '&'))
  const links = hrefs.filter(h => h.startsWith(MEMBERS_URL))
  expect(links).toHaveLength(1)
  return links[0]
}

async function seedPendingInvite(email: string, invitedBy: string | null, messageId: string) {
  const id = await seedUser({ email, invitedBy })
  await seedAuthEvent(id, 'email_sent', {
    email, linkType: 'invite', provider: 'cloudflare', messageId, createdAt: HOUR_AGO,
  })
  return id
}

const bounced = (errorCause: string) => ({ status: 'deliveryFailed', isSpam: false, errorCause })

describe('hourly run: emailing the inviter about bounced invites', () => {
  let ownerId: string
  beforeEach(async () => {
    await resetDb(); await applyMigrations()
    ownerId = await seedUser({ role: 'owner', email: 'owner@example.test', name: 'Olive Owner' })
  })
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

  it('sends the inviting Admin one email naming the address and the reason', async () => {
    const adminId = await seedUser({ role: 'admin', email: 'admin@example.test' })
    await seedPendingInvite('typo@example.test', adminId, 'm-1')
    const { e, cf } = stubs({ 'm-1': bounced('550 5.1.1 user unknown') })

    await runHourly(e)

    expect(sentTo(cf)).toEqual(['admin@example.test'])
    const mail = mailFor(cf, 'admin@example.test')
    expect(mail.subject).toBe("An invite couldn't be delivered")
    expect(mail.html).toContain('typo@example.test')
    expect(mail.html).toContain('550 5.1.1 user unknown')
    expect(mail.text).toContain('typo@example.test')
    expect(mail.text).toContain('550 5.1.1 user unknown')
  })

  it('sends an inviting Owner the email directly', async () => {
    await seedPendingInvite('typo@example.test', ownerId, 'm-1')
    const { e, cf } = stubs({ 'm-1': bounced('user unknown') })

    await runHourly(e)

    expect(sentTo(cf)).toEqual(['owner@example.test'])
  })

  it('lists several bounces for the same inviter in one email', async () => {
    const adminId = await seedUser({ role: 'admin', email: 'admin@example.test' })
    await seedPendingInvite('one@example.test', adminId, 'm-1')
    await seedPendingInvite('two@example.test', adminId, 'm-2')
    await seedPendingInvite('three@example.test', adminId, 'm-3')
    const { e, cf } = stubs({
      'm-1': bounced('reason one'),
      'm-2': bounced('reason two'),
      'm-3': bounced('reason three'),
    })

    await runHourly(e)

    expect(cf.sent).toHaveLength(1)
    const mail = mailFor(cf, 'admin@example.test')
    expect(mail.subject).toBe("3 invites couldn't be delivered")
    for (const [addr, reason] of [['one', 'reason one'], ['two', 'reason two'], ['three', 'reason three']]) {
      expect(mail.html).toContain(`${addr}@example.test`)
      expect(mail.html).toContain(reason)
    }
  })

  it('sends one email per inviter when bounces have different inviters', async () => {
    const a = await seedUser({ role: 'admin', email: 'a@example.test' })
    const b = await seedUser({ role: 'admin', email: 'b@example.test' })
    await seedPendingInvite('x@example.test', a, 'm-1')
    await seedPendingInvite('y@example.test', b, 'm-2')
    const { e, cf } = stubs({ 'm-1': bounced('rx'), 'm-2': bounced('ry') })

    await runHourly(e)

    expect(sentTo(cf)).toEqual(['a@example.test', 'b@example.test'])
    expect(mailFor(cf, 'a@example.test').html).not.toContain('y@example.test')
    expect(mailFor(cf, 'b@example.test').html).not.toContain('x@example.test')
  })

  it.each([
    ['deactivated', { role: 'admin' as const, deactivatedAt: '2026-09-20 00:00:00' }],
    ['demoted to Standard member', { role: 'member' as const }],
    ['a deactivated Owner', { role: 'owner' as const, deactivatedAt: '2026-09-20 00:00:00' }],
  ])('sends to every active Owner when the inviter is %s', async (_label, inviter) => {
    const otherOwner = 'owner2@example.test'
    await seedUser({ role: 'owner', email: otherOwner })
    await seedUser({ role: 'owner', email: 'gone-owner@example.test', deactivatedAt: '2026-09-01 00:00:00' })
    await seedUser({ role: 'admin', email: 'bystander-admin@example.test' })
    const inviterId = await seedUser({ ...inviter, email: 'inviter@example.test' })
    await seedPendingInvite('typo@example.test', inviterId, 'm-1')
    const { e, cf } = stubs({ 'm-1': bounced('user unknown') })

    await runHourly(e)

    expect(sentTo(cf)).toEqual(['owner2@example.test', 'owner@example.test'])
    expect(mailFor(cf, otherOwner).html).toContain('typo@example.test')
  })

  it('never checks or emails about a member with no inviter (one who joined another way)', async () => {
    await seedPendingInvite('no-inviter@example.test', null, 'm-1')
    const { e, cf, emailDeliveryStatus } = stubs({ 'm-1': bounced('r1') })

    await runHourly(e)

    expect(emailDeliveryStatus).not.toHaveBeenCalled()
    expect(cf.sent).toHaveLength(0)
    expect(await getDb(env.DB).select().from(authEvents).where(eq(authEvents.event, 'email_bounced')).all()).toHaveLength(0)
  })

  it('does not email about a send to an address the member no longer has', async () => {
    const adminId = await seedUser({ role: 'admin', email: 'admin@example.test' })
    const memberId = await seedPendingInvite('typo@exmaple.test', adminId, 'm-old')
    await getDb(env.DB).update(users).set({ email: 'typo@example.test' }).where(eq(users.id, memberId))
    const { e, cf } = stubs({ 'm-old': bounced('user unknown') })

    await runHourly(e)

    expect(cf.sent).toHaveLength(0)
  })

  it('sends nothing, and still records the bounce, when there is no active Owner to fall back to', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const formerAdmin = await seedUser({ role: 'member', email: 'former-admin@example.test' })
    await getDb(env.DB).update(users).set({ deactivatedAt: '2026-09-01 00:00:00' }).where(eq(users.id, ownerId))
    await seedPendingInvite('orphan@example.test', formerAdmin, 'm-1')
    const { e, cf } = stubs({ 'm-1': bounced('r1') })

    await runHourly(e)

    expect(cf.sent).toHaveLength(0)
    expect(await getDb(env.DB).select().from(authEvents).where(eq(authEvents.event, 'email_bounced')).all()).toHaveLength(1)
    expect(warn.mock.calls.map(c => c.join(' ')).join('\n')).toContain('no active Owner')
  })

  it('sends an inviter who is also an Owner one email covering their own bounce and the fallback', async () => {
    await seedUser({ role: 'owner', email: 'owner2@example.test' })
    const formerAdmin = await seedUser({ role: 'member', email: 'former-admin@example.test' })
    await seedPendingInvite('mine@example.test', ownerId, 'm-1')
    await seedPendingInvite('orphan@example.test', formerAdmin, 'm-2')
    const { e, cf } = stubs({ 'm-1': bounced('r1'), 'm-2': bounced('r2') })

    await runHourly(e)

    expect(sentTo(cf)).toEqual(['owner2@example.test', 'owner@example.test'])
    const mine = mailFor(cf, 'owner@example.test')
    expect(mine.html).toContain('mine@example.test')
    expect(mine.html).toContain('orphan@example.test')
    const other = mailFor(cf, 'owner2@example.test')
    expect(other.html).toContain('orphan@example.test')
    expect(other.html).not.toContain('mine@example.test')
  })

  it('lists an address once when its invite and a sign-in link both bounced in the same run', async () => {
    const adminId = await seedUser({ role: 'admin', email: 'admin@example.test' })
    const memberId = await seedPendingInvite('typo@example.test', adminId, 'm-1')
    await seedAuthEvent(memberId, 'email_sent', {
      email: 'typo@example.test', linkType: 'login', provider: 'cloudflare', messageId: 'm-2', createdAt: HOUR_AGO,
    })
    const { e, cf } = stubs({ 'm-1': bounced('user unknown'), 'm-2': bounced('user unknown') })

    await runHourly(e)

    const mail = mailFor(cf, 'admin@example.test')
    expect(mail.subject).toBe("An invite couldn't be delivered")
    expect(mail.html.match(/typo@example\.test/g)).toHaveLength(1)
    expect(new URL(membersLink(mail.html)).searchParams.get('search')).toBe('typo@example.test')
  })

  it('sends nothing when nothing bounced', async () => {
    const adminId = await seedUser({ role: 'admin', email: 'admin@example.test' })
    await seedPendingInvite('ok@example.test', adminId, 'm-1')
    await seedPendingInvite('slow@example.test', adminId, 'm-2')
    const { e, cf } = stubs({
      'm-1': { status: 'delivered', isSpam: false },
      'm-2': { status: 'deferred', isSpam: false },
    })

    await runHourly(e)

    expect(cf.sent).toHaveLength(0)
  })

  it('sends nothing when there is nothing to check', async () => {
    const { e, cf, emailDeliveryStatus } = stubs({})

    await runHourly(e)

    expect(emailDeliveryStatus).not.toHaveBeenCalled()
    expect(cf.sent).toHaveLength(0)
  })

  it('sends nothing and does not throw when the delivery lookup fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const adminId = await seedUser({ role: 'admin', email: 'admin@example.test' })
    await seedPendingInvite('typo@example.test', adminId, 'm-1')
    const { e, cf } = stubs(async () => { throw new Error('central unavailable') })

    await runHourly(e)

    expect(cf.sent).toHaveLength(0)
  })

  it('never notifies a bounce twice across consecutive runs', async () => {
    const adminId = await seedUser({ role: 'admin', email: 'admin@example.test' })
    await seedPendingInvite('typo@example.test', adminId, 'm-1')
    const { e, cf } = stubs({ 'm-1': bounced('user unknown') })

    await runHourly(e)
    await runHourly(e, NOW + 3600_000)
    await runHourly(e, NOW + 2 * 3600_000)

    expect(cf.sent).toHaveLength(1)
  })

  it('notifies only the new bounce when a later run finds another', async () => {
    const adminId = await seedUser({ role: 'admin', email: 'admin@example.test' })
    await seedPendingInvite('first@example.test', adminId, 'm-1')
    await seedPendingInvite('second@example.test', adminId, 'm-2')
    const runs: Delivery[] = [
      { 'm-1': bounced('r1'), 'm-2': { status: 'deferred', isSpam: false } },
      { 'm-2': bounced('r2') },
    ]
    const { e, cf } = stubs(async () => runs.shift())

    await runHourly(e)
    await runHourly(e, NOW + 3600_000)

    expect(cf.sent).toHaveLength(2)
    const [first, second] = cf.sent
    expect(first.html).toContain('first@example.test')
    expect(first.html).not.toContain('second@example.test')
    expect(second.html).toContain('second@example.test')
    expect(second.html).not.toContain('first@example.test')
  })

  it('still records every bounce when the notification send fails, and does not resend next run', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const a = await seedUser({ role: 'admin', email: 'a@example.test' })
    const b = await seedUser({ role: 'admin', email: 'b@example.test' })
    await seedPendingInvite('x@example.test', a, 'm-1')
    await seedPendingInvite('y@example.test', b, 'm-2')
    // The first send fails on the binding, and the second goes through.
    const { e, cf } = stubs({ 'm-1': bounced('rx'), 'm-2': bounced('ry') }, ['down', 'ok'])
    // Operator mail falls back (#709), so both providers are down for that one: the binding failed above, and Resend answers 500.
    const resend = stubResend('down', { status: 500, body: 'down' })

    await runHourly(e)

    const recorded = await getDb(env.DB).select().from(authEvents).where(eq(authEvents.event, 'email_bounced')).all()
    expect(recorded.map(r => r.email).sort()).toEqual(['x@example.test', 'y@example.test'])
    // The other recipient's email still went out, and the failed one was tried on the second provider.
    expect(cf.sent).toHaveLength(2)
    expect(resend.calls).toHaveLength(1)
    expect(error.mock.calls.map(c => c.join(' ')).join('\n')).toContain('[invite-bounces]')

    await runHourly(e, NOW + 3600_000)
    expect(cf.sent).toHaveLength(2)
  })

  it('links to Members with the address searched when exactly one address bounced', async () => {
    const adminId = await seedUser({ role: 'admin', email: 'admin@example.test' })
    await seedPendingInvite('first.last+tag@example.test', adminId, 'm-1')
    const { e, cf } = stubs({ 'm-1': bounced('user unknown') })

    await runHourly(e)

    const url = new URL(membersLink(mailFor(cf, 'admin@example.test').html))
    expect(url.origin + url.pathname).toBe(MEMBERS_URL)
    expect(url.searchParams.get('search')).toBe('first.last+tag@example.test')
  })

  it('links to Members without a search when more than one address bounced', async () => {
    const adminId = await seedUser({ role: 'admin', email: 'admin@example.test' })
    await seedPendingInvite('one@example.test', adminId, 'm-1')
    await seedPendingInvite('two@example.test', adminId, 'm-2')
    const { e, cf } = stubs({ 'm-1': bounced('r1'), 'm-2': bounced('r2') })

    await runHourly(e)

    expect(membersLink(mailFor(cf, 'admin@example.test').html)).toBe(MEMBERS_URL)
  })

  it('decides the search parameter per recipient, by the addresses in their own email', async () => {
    const adminId = await seedUser({ role: 'admin', email: 'admin@example.test' })
    const formerAdmin = await seedUser({ role: 'member', email: 'former-admin@example.test' })
    await seedPendingInvite('mine@example.test', adminId, 'm-1')
    await seedPendingInvite('orphan@example.test', formerAdmin, 'm-2')
    const { e, cf } = stubs({ 'm-1': bounced('r1'), 'm-2': bounced('r2') })

    await runHourly(e)

    expect(new URL(membersLink(mailFor(cf, 'admin@example.test').html)).searchParams.get('search')).toBe('mine@example.test')
    expect(new URL(membersLink(mailFor(cf, 'owner@example.test').html)).searchParams.get('search')).toBe('orphan@example.test')
  })

  it('HTML-escapes the address and the reason', async () => {
    const adminId = await seedUser({ role: 'admin', email: 'admin@example.test' })
    const evil = '<b>x</b>&"y"@example.test'
    await seedPendingInvite(evil, adminId, 'm-1')
    const { e, cf } = stubs({ 'm-1': bounced('<script>alert(1)</script> & 550 "rejected"') })

    await runHourly(e)

    const { html } = mailFor(cf, 'admin@example.test')
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('<b>x</b>')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; 550')
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;&amp;')
    // The address also reaches the link, URL-encoded, and cannot break out of the href.
    expect(new URL(membersLink(html)).searchParams.get('search')).toBe(evil)
  })

  it('shows the instance name and links to the instance', async () => {
    const adminId = await seedUser({ role: 'admin', email: 'admin@example.test' })
    await seedPendingInvite('typo@example.test', adminId, 'm-1')
    const { e, cf } = stubs({ 'm-1': bounced('user unknown') })

    await getDb(env.DB).update(associationConfig).set({ value: JSON.stringify('Sample Instance') })
      .where(eq(associationConfig.key, 'association_name'))

    await runHourly(e)

    const { html } = mailFor(cf, 'admin@example.test')
    expect(html).toContain('Sample Instance')
    expect(html).toContain('/email-icons/wordmark.png')
  })
})
