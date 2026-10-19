import { env } from 'cloudflare:test'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { app } from '../../src/index'
import { clearDb, seedUser, seedSession, seedMagicLink } from '../helpers'
import { fakeBinding, stubResend } from '../../../shared/emailTestKit'
import { getDb } from '../../src/db/client'
import { users, sessions, authEvents, emailChanges, emailChangeReports, emailSendStats } from '../../src/db/schema'
import { _resetSuperadminAllowlistCache } from '../../src/lib/superadminCentral'
import { hashToken } from '../../src/lib/crypto'
import { issueNotMeToken, reportNotMe } from '../../src/lib/emailChangeReport'

// "This wasn't me" from the old address of an email change (#415). The old
// address's notices carry a link whose button, once pressed, signs the member
// out everywhere and alerts the instance's owners and admins. Outgoing email is
// captured from a fake Cloudflare EMAIL binding.

type Sent = { to: string[]; subject: string; html: string; text: string }

let sent: Sent[]
let sendFails: boolean
// The binding every request sends through, and the messages it accepted. It is
// down while `sendFails` is set. A test that needs another answer calls
// `useBinding`, which makes it the one `sent` reads.
let cf: ReturnType<typeof fakeBinding>
function useBinding(outcomes: Parameters<typeof fakeBinding>[0] = () => (sendFails ? 'down' : 'ok')) {
  cf = fakeBinding(outcomes)
  sent = cf.delivered as unknown as Sent[]
  return cf
}

function testEnv(extra: Record<string, unknown> = {}) {
  return {
    ...env,
    EMAIL_PROVIDER: 'cloudflare',
    EMAIL: cf.binding,
    CENTRAL: {
      fetch: async () => new Response(JSON.stringify({ hashes: [] })),
      emailSuppressionMany: async (emails: string[]) => Object.fromEntries(emails.map(e => [e, { suppressed: false }])),
    },
    ...extra,
  } as unknown as typeof env
}

type Reply = { status: number; body: Record<string, unknown>; headers: Headers }

async function call(path: string, init: RequestInit & { cookie?: string } = {}, extraEnv: Record<string, unknown> = {}): Promise<Reply> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (init.cookie) headers.Cookie = init.cookie
  const res = await app.request(path, { ...init, headers }, testEnv(extraEnv))
  return { status: res.status, body: await res.json() as Record<string, unknown>, headers: res.headers }
}

const request = (cookie: string, email: string) =>
  call('/api/users/me/email-change', { method: 'POST', cookie, body: JSON.stringify({ email }) })
const confirm = (token: string) =>
  call('/api/auth/email-change/confirm', { method: 'POST', body: JSON.stringify({ token }) })
const status = (token: string) =>
  call('/api/auth/email-change/not-me/status', { method: 'POST', body: JSON.stringify({ token }) })
const press = (token: string, extraEnv: Record<string, unknown> = {}) =>
  call('/api/auth/email-change/not-me', { method: 'POST', body: JSON.stringify({ token }) }, extraEnv)

const CONFIRM_LINK = /\/auth\/confirm-email\?token=([0-9a-f]+)/
const NOT_ME_LINK = /\/auth\/not-me\?token=([0-9a-f]+)/

/** The raw "This wasn't me" token in the nth (from 0, default last) notice sent to `to`. */
function notMeTokenSentTo(to: string, nth?: number): string {
  const mails = sent.filter(m => m.to.includes(to) && NOT_ME_LINK.test(m.text))
  const mail = nth === undefined ? mails[mails.length - 1] : mails[nth]
  if (!mail) throw new Error(`no "This wasn't me" link sent to ${to}`)
  return mail.text.match(NOT_ME_LINK)![1]
}

async function member(id: string) {
  return (await getDb(env.DB).select().from(users).where(eq(users.id, id)).get())!
}
async function eventsFor(id: string) {
  return getDb(env.DB).select().from(authEvents).where(eq(authEvents.userId, id)).all()
}
async function sessionCount(userId: string) {
  return (await getDb(env.DB).select().from(sessions).where(eq(sessions.userId, userId)).all()).length
}
const reportRows = () => getDb(env.DB).select().from(emailChangeReports).all()
const alerts = () => sent.filter(m => m.subject.includes("didn't change their sign-in email"))

let jane: string
let janeSession: string
let janeCookie: string
let owner: string
let admin: string

beforeEach(async () => {
  await clearDb()
  _resetSuperadminAllowlistCache()
  useBinding()
  sendFails = false
  jane = await seedUser({ email: 'jane@oldjob.org', name: 'Jane Doe' })
  janeSession = await seedSession(jane)
  janeCookie = `session=${janeSession}`
  owner = await seedUser({ role: 'owner', email: 'olive@org.org', name: 'Olive Owner' })
  admin = await seedUser({ role: 'admin', email: 'ada@org.org', name: 'Ada Admin' })
})

describe('the notices to the old address', () => {
  it('carry a "This wasn\'t me" link with a token of its own, at request and at commit', async () => {
    await request(janeCookie, 'jane@newjob.org')
    const atRequest = notMeTokenSentTo('jane@oldjob.org')
    expect(atRequest).toMatch(/^[0-9a-f]{64}$/)
    expect(sent.find(m => m.to.includes('jane@oldjob.org'))!.html).toContain(`/auth/not-me?token=${atRequest}`)

    await confirm(sent.find(m => m.to.includes('jane@newjob.org'))!.text.match(CONFIRM_LINK)![1])
    const atCommit = notMeTokenSentTo('jane@oldjob.org')
    expect(atCommit).toMatch(/^[0-9a-f]{64}$/)
    expect(atCommit).not.toBe(atRequest)
    expect(await reportRows()).toHaveLength(2)
  })

  it('store the token hashed, never raw, scoped to the member and the change', async () => {
    await request(janeCookie, 'jane@newjob.org')
    const token = notMeTokenSentTo('jane@oldjob.org')
    const [row] = await reportRows()
    const [change] = await getDb(env.DB).select().from(emailChanges).all()
    expect(row.tokenHash).toBe(await hashToken(token))
    expect(JSON.stringify(row)).not.toContain(token)
    expect(row).toMatchObject({ userId: jane, changeId: change.id, oldEmail: 'jane@oldjob.org', newEmail: 'jane@newjob.org', requestedBy: jane })
    // Valid for 7 days, and not much longer.
    const days = (new Date(`${row.expiresAt.replace(' ', 'T')}Z`).getTime() - Date.now()) / 86_400_000
    expect(days).toBeGreaterThan(6.9)
    expect(days).toBeLessThan(7.1)
  })

  it('keep the commit notice working after the pending change is gone', async () => {
    await request(janeCookie, 'jane@newjob.org')
    await confirm(sent.find(m => m.to.includes('jane@newjob.org'))!.text.match(CONFIRM_LINK)![1])
    expect(await getDb(env.DB).select().from(emailChanges).all()).toHaveLength(0)
    expect((await status(notMeTokenSentTo('jane@oldjob.org'))).body).toEqual({ status: 'valid' })
  })
})

describe('loading the link', () => {
  let token: string
  beforeEach(async () => {
    await request(janeCookie, 'jane@newjob.org')
    token = notMeTokenSentTo('jane@oldjob.org')
    useBinding()
  })

  it('changes nothing', async () => {
    for (let i = 0; i < 2; i++) {
      const r = await status(token)
      expect(r.status).toBe(200)
      expect(r.body).toEqual({ status: 'valid' })
      expect(r.headers.get('Referrer-Policy')).toBe('no-referrer')
      expect(r.headers.get('Set-Cookie')).toBeNull()
    }
    expect(await sessionCount(jane)).toBe(1)
    expect(await reportRows()).toHaveLength(1)
    expect((await eventsFor(jane)).filter(e => e.event === 'email_change_reported')).toHaveLength(0)
    expect(sent).toHaveLength(0)
  })

  it('keeps the token out of the URL: a GET with the token in the query is not served', async () => {
    const res = await app.request(`/api/auth/email-change/not-me/status?token=${token}`, {}, testEnv())
    expect(res.status).toBe(404)
    const pressed = await app.request(`/api/auth/email-change/not-me?token=${token}`, { method: 'GET' }, testEnv())
    expect(pressed.status).toBe(404)
    expect(await sessionCount(jane)).toBe(1)
  })

  it('reveals nothing about the change', async () => {
    const r = await status(token)
    expect(JSON.stringify(r.body)).not.toContain('newjob')
  })
})

describe('pressing the button', () => {
  let token: string
  let confirmToken: string
  let bob: string
  beforeEach(async () => {
    bob = await seedUser({ email: 'bob@org.org', name: 'Bob Member' })
    await seedSession(bob)
    await seedSession(jane)
    await request(janeCookie, 'jane@newjob.org')
    token = notMeTokenSentTo('jane@oldjob.org')
    confirmToken = sent.find(m => m.to.includes('jane@newjob.org'))!.text.match(CONFIRM_LINK)![1]
    useBinding()
  })

  it("ends every one of the member's sessions, and nobody else's", async () => {
    expect(await sessionCount(jane)).toBe(2)
    const r = await press(token)
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ ok: true, alerted: true, cancelled: true })
    expect(r.headers.get('Referrer-Policy')).toBe('no-referrer')
    expect(r.headers.get('Set-Cookie')).toBeNull()
    expect(await sessionCount(jane)).toBe(0)
    expect(await sessionCount(bob)).toBe(1)
  })

  it('emails every active owner and admin the member, both addresses, who asked, and when', async () => {
    const deactivated = await seedUser({ role: 'admin', email: 'gone@org.org', deactivatedAt: '2026-01-01 00:00:00' })
    expect(deactivated).toBeTruthy()
    await press(token)
    expect(alerts().map(m => m.to).sort()).toEqual([['ada@org.org'], ['olive@org.org']])
    for (const mail of alerts()) {
      const body = `${mail.html} ${mail.text}`
      expect(body).toContain('Jane Doe')
      expect(body).toContain('jane@oldjob.org')
      expect(body).toContain('jane@newjob.org')
      expect(mail.text).toContain('Requested by: the member')
      expect(mail.text).toMatch(/Requested: \w+ \d{1,2}, \d{4} at \d{1,2}:\d{2} [ap]\.m\. UTC/)
      expect(mail.text).toContain('The pending change to jane@newjob.org was cancelled')
    }
    // Nobody else hears of it: not the standard member, and no mail to the member.
    expect(sent.filter(m => m.to.includes('bob@org.org') || m.to.includes('jane@oldjob.org') || m.to.includes('jane@newjob.org'))).toHaveLength(0)
  })

  it("cancels the member's pending change, so the confirmation link can no longer commit it", async () => {
    await press(token)
    expect(await getDb(env.DB).select().from(emailChanges).all()).toHaveLength(0)
    const r = await confirm(confirmToken)
    expect(r.status).toBe(404)
    expect((await member(jane)).email).toBe('jane@oldjob.org')
    const [ev] = (await eventsFor(jane)).filter(e => e.event === 'email_change_cancelled')
    expect(ev).toMatchObject({ email: 'jane@newjob.org', reason: 'jane@oldjob.org', actorId: null })
  })

  it('leaves another member\'s pending change alone', async () => {
    const bobToken = await issueNotMeToken(getDb(env.DB), {
      id: crypto.randomUUID(), userId: bob, oldEmail: 'bob@org.org', newEmail: 'bob@elsewhere.org', requestedBy: bob,
    })
    await getDb(env.DB).insert(emailChanges).values({
      id: crypto.randomUUID(), userId: bob, oldEmail: 'bob@org.org', newEmail: 'bob@elsewhere.org', requestedBy: bob,
      tokenHash: 'bobhash', expiresAt: '2999-01-01 00:00:00',
    })
    await press(bobToken)
    const left = await getDb(env.DB).select().from(emailChanges).all()
    expect(left.map(r => r.userId)).toEqual([jane])
  })

  it('tells the admins which pending change was cancelled', async () => {
    await press(token)
    expect(alerts()[0].text).toContain('The pending change to jane@newjob.org was cancelled')
    expect(alerts()[0].text).toContain('Their sign-in email is still the old address')
  })

  it("does not cancel a pending change the member did not start: an admin's survives, and the admins are told", async () => {
    // Moving away from an old mailbox someone else holds must stay possible through an admin.
    await env.DB.prepare('DELETE FROM email_changes').run()
    await getDb(env.DB).insert(emailChanges).values({
      id: crypto.randomUUID(), userId: jane, oldEmail: 'jane@oldjob.org', newEmail: 'jane@adminpick.org', requestedBy: admin,
      tokenHash: 'adminhash', expiresAt: '2999-01-01 00:00:00',
    })
    const r = await press(token)
    expect(r.status).toBe(200)
    expect(await sessionCount(jane)).toBe(0)
    const left = await getDb(env.DB).select().from(emailChanges).all()
    expect(left.map(c => c.newEmail)).toEqual(['jane@adminpick.org'])
    expect((await eventsFor(jane)).filter(e => e.event === 'email_change_cancelled').filter(e => e.email === 'jane@adminpick.org')).toHaveLength(0)
    expect(alerts()[0].text).toContain('A pending change to jane@adminpick.org was not cancelled and is still waiting for confirmation')
    expect(alerts()[0].text).not.toContain('was cancelled, so')
  })

  it("does not let a committed change's token cancel a newer change its mailbox was never told about", async () => {
    await confirm(confirmToken)
    const atCommit = notMeTokenSentTo('jane@oldjob.org')
    // The member (now at jane@newjob.org) asks to move on. The notices for this go to jane@newjob.org.
    expect((await request(janeCookie, 'jane@newer.org')).status).toBe(200)
    useBinding()
    expect((await press(atCommit)).status).toBe(200)
    const left = await getDb(env.DB).select().from(emailChanges).all()
    expect(left.map(c => [c.oldEmail, c.newEmail])).toEqual([['jane@newjob.org', 'jane@newer.org']])
    expect((await member(jane)).email).toBe('jane@newjob.org')
    expect(alerts()[0].text).toContain('A pending change to jane@newer.org was not cancelled and is still waiting for confirmation')
  })

  it('says so when the address has since moved on to a third address', async () => {
    await confirm(confirmToken)
    const atCommit = notMeTokenSentTo('jane@oldjob.org')
    await request(janeCookie, 'jane@newer.org')
    await confirm(sent.filter(m => m.to.includes('jane@newer.org')).pop()!.text.match(CONFIRM_LINK)![1])
    expect((await member(jane)).email).toBe('jane@newer.org')
    useBinding()
    await press(atCommit)
    const text = alerts()[0].text
    expect(text).toContain('The change had already taken effect, and their sign-in email has since changed again, to jane@newer.org')
    expect(text).not.toContain('had not taken effect')
    expect(text).not.toContain('still the old address')
  })

  it('says the change took effect and was restored, when an admin put the old address back', async () => {
    await confirm(confirmToken)
    const atCommit = notMeTokenSentTo('jane@oldjob.org')
    await getDb(env.DB).update(users).set({ email: 'jane@oldjob.org' }).where(eq(users.id, jane))
    useBinding()
    await press(atCommit)
    const text = alerts()[0].text
    expect(text).toContain('The change had taken effect, and their sign-in email has since been restored to the old address')
    expect(text).not.toContain('had not taken effect')
  })

  it('makes no claim about history when the member is at the old address and the change never committed', async () => {
    await press(token)
    const text = alerts()[0].text
    expect(text).toContain('Their sign-in email is still the old address')
    expect(text).not.toContain('had not taken effect')
    expect(text).not.toContain('restored')
  })

  it("names the pending change that was cancelled when it was not the one the notice described", async () => {
    // The member's request to jane@newjob.org was replaced from the same mailbox
    // by one to jane@third.org. Pressing the first notice's link cancels the second.
    await request(janeCookie, 'jane@third.org')
    useBinding()
    await press(token)
    expect(await getDb(env.DB).select().from(emailChanges).all()).toHaveLength(0)
    const text = alerts()[0].text
    expect(text).toContain('The pending change to jane@third.org was cancelled')
    expect(text).not.toContain('pending change to jane@newjob.org')
  })

  it('does not reverse a change that has taken effect, and says so to the admins', async () => {
    // Confirm from the new address, then report from the commit notice.
    await confirm(confirmToken)
    const atCommit = notMeTokenSentTo('jane@oldjob.org')
    useBinding()
    const r = await press(atCommit)
    expect(r.status).toBe(200)
    expect(r.body.cancelled).toBe(false)
    expect((await member(jane)).email).toBe('jane@newjob.org')
    expect(alerts()[0].text).toContain('The change had already taken effect')
    expect(alerts()[0].text).not.toContain('was cancelled')
    expect(await getDb(env.DB).select().from(emailChanges).all()).toHaveLength(0)
    expect((await eventsFor(jane)).filter(e => e.event === 'email_change_cancelled')).toHaveLength(0)
    expect(alerts()[0].text).toContain('Old address: jane@oldjob.org')
    expect(alerts()[0].text).toContain('New address: jane@newjob.org')
  })

  it('records the event with both addresses, and shows it in both histories', async () => {
    await press(token)
    const [ev] = (await eventsFor(jane)).filter(e => e.event === 'email_change_reported')
    expect(ev).toMatchObject({ email: 'jane@newjob.org', reason: 'jane@oldjob.org', actorId: null })

    // Signed out everywhere, so the member reads their own history after signing back in.
    const again = await seedSession(jane)
    const own = await call('/api/users/me/auth-events', { cookie: `session=${again}` })
    expect((own.body.events as { event: string }[]).map(e => e.event)).toContain('email_change_reported')

    const adminView = await call(`/api/admin/members/${jane}/auth-events`, { cookie: `session=${await seedSession(admin)}` })
    const found = (adminView.body.events as { event: string; email: string; reason: string }[]).find(e => e.event === 'email_change_reported')
    expect(found).toMatchObject({ email: 'jane@newjob.org', reason: 'jane@oldjob.org' })
  })

  it('works once: a second press does nothing, and leaves later sign-ins alone', async () => {
    expect((await press(token)).status).toBe(200)
    useBinding()
    const signedBackIn = await seedSession(jane)
    expect(signedBackIn).toBeTruthy()
    const again = await press(token)
    expect(again.status).toBe(404)
    expect(again.body).toEqual({ error: 'This link is no longer valid. It may have been used already.' })
    expect(await sessionCount(jane)).toBe(1)
    expect(sent).toHaveLength(0)
    expect((await status(token)).body).toEqual({ status: 'invalid' })
    expect((await eventsFor(jane)).filter(e => e.event === 'email_change_reported')).toHaveLength(1)
  })

  it('works once even when two presses race', async () => {
    const results = await Promise.all([press(token), press(token)])
    expect(results.map(r => r.status).sort()).toEqual([200, 404])
    expect(alerts()).toHaveLength(2)
    expect((await eventsFor(jane)).filter(e => e.event === 'email_change_reported')).toHaveLength(1)
  })

  it("spends the other notice's link too, so a change alerts the admins once", async () => {
    await confirm(confirmToken)
    const atRequest = token
    const atCommit = notMeTokenSentTo('jane@oldjob.org')
    expect((await press(atRequest)).status).toBe(200)
    useBinding()
    expect((await press(atCommit)).status).toBe(404)
    expect(sent).toHaveLength(0)
  })

  it('is scoped to its member: another member\'s token never ends this member\'s sessions', async () => {
    const bobToken = await issueNotMeToken(getDb(env.DB), {
      id: crypto.randomUUID(), userId: bob, oldEmail: 'bob@org.org', newEmail: 'bob@elsewhere.org', requestedBy: bob,
    })
    await press(bobToken)
    expect(await sessionCount(bob)).toBe(0)
    expect(await sessionCount(jane)).toBe(2)
  })

  it('names the admin when an admin asked for the change', async () => {
    const adminToken = await issueNotMeToken(getDb(env.DB), {
      id: crypto.randomUUID(), userId: jane, oldEmail: 'jane@oldjob.org', newEmail: 'jane@elsewhere.org', requestedBy: admin,
    })
    await press(adminToken)
    expect(alerts()[0].text).toContain('Requested by: Ada Admin (ada@org.org)')
  })

  it('shows a nameless admin by email once, not as "email (email)"', async () => {
    await env.DB.prepare('UPDATE users SET name = ? WHERE id = ?').bind('', admin).run()
    const adminToken = await issueNotMeToken(getDb(env.DB), {
      id: crypto.randomUUID(), userId: jane, oldEmail: 'jane@oldjob.org', newEmail: 'jane@elsewhere.org', requestedBy: admin,
    })
    await press(adminToken)
    expect(alerts()[0].text).toContain('Requested by: ada@org.org\n')
  })

  it('shows an admin whose legacy name is only whitespace by email once', async () => {
    await env.DB.prepare('UPDATE users SET name = ? WHERE id = ?').bind('   ', admin).run()
    const adminToken = await issueNotMeToken(getDb(env.DB), {
      id: crypto.randomUUID(), userId: jane, oldEmail: 'jane@oldjob.org', newEmail: 'jane@elsewhere.org', requestedBy: admin,
    })
    await press(adminToken)
    expect(alerts()[0].text).toContain('Requested by: ada@org.org\n')
  })

  it('still signs the member out, and says so, when no alert could be sent', async () => {
    // Both providers are down: the binding throws, and the fallback (Resend) answers 500.
    stubResend('down', { status: 500, body: 'upstream error' })
    sendFails = true
    const r = await press(token)
    expect(r).toMatchObject({ status: 200, body: { ok: true, alerted: false } })
    expect(await sessionCount(jane)).toBe(0)
    expect((await eventsFor(jane)).filter(e => e.event === 'email_change_reported')).toHaveLength(1)
  })

  it('does not alert the member who reported, even when they are an admin, and warns when nobody else is left', async () => {
    await env.DB.prepare('UPDATE users SET role = ? WHERE id = ?').bind('admin', jane).run()
    await env.DB.prepare('UPDATE users SET deactivated_at = datetime(\'now\') WHERE id IN (?, ?)').bind(owner, admin).run()
    const r = await press(token)
    expect(r).toMatchObject({ status: 200, body: { ok: true, alerted: false } })
    expect(await sessionCount(jane)).toBe(0)
    expect(sent).toHaveLength(0)
  })
})

describe('an expired or unknown link', () => {
  it('does nothing when the token has expired', async () => {
    await request(janeCookie, 'jane@newjob.org')
    const token = notMeTokenSentTo('jane@oldjob.org')
    await env.DB.prepare("UPDATE email_change_reports SET expires_at = datetime('now', '-1 minute')").run()
    useBinding()

    expect((await status(token)).body).toEqual({ status: 'expired' })
    const r = await press(token)
    expect(r.status).toBe(410)
    expect(r.body.error).toMatch(/has expired/)
    expect(await sessionCount(jane)).toBe(1)
    expect(sent).toHaveLength(0)
    expect((await eventsFor(jane)).filter(e => e.event === 'email_change_reported')).toHaveLength(0)
  })

  it('does nothing for a made-up or missing token', async () => {
    await request(janeCookie, 'jane@newjob.org')
    useBinding()
    for (const body of [{ token: 'deadbeef' }, { token: '' }, {}, { token: 42 }]) {
      const r = await call('/api/auth/email-change/not-me', { method: 'POST', body: JSON.stringify(body) })
      expect(r.status).toBe(404)
    }
    expect((await status('deadbeef')).body).toEqual({ status: 'invalid' })
    expect(await sessionCount(jane)).toBe(1)
    expect(sent).toHaveLength(0)
  })

  it('does not honor a confirmation token as a "This wasn\'t me" token', async () => {
    await request(janeCookie, 'jane@newjob.org')
    const confirmToken = sent.find(m => m.to.includes('jane@newjob.org'))!.text.match(CONFIRM_LINK)![1]
    expect((await press(confirmToken)).status).toBe(404)
    expect(await sessionCount(jane)).toBe(1)
  })

  it('clears expired tokens out when a new one is issued', async () => {
    await request(janeCookie, 'jane@newjob.org')
    await env.DB.prepare("UPDATE email_change_reports SET expires_at = datetime('now', '-1 day')").run()
    await request(janeCookie, 'jane@third.org')
    const rows = await reportRows()
    expect(rows).toHaveLength(1)
    expect(rows[0].newEmail).toBe('jane@third.org')
  })

  it('is gone with the member', async () => {
    await request(janeCookie, 'jane@newjob.org')
    const token = notMeTokenSentTo('jane@oldjob.org')
    await getDb(env.DB).delete(users).where(eq(users.id, jane))
    expect((await status(token)).body).toEqual({ status: 'invalid' })
  })
})

describe('a signed-out member and a magic link', () => {
  it('does not sign anyone in, and does not touch sign-in links', async () => {
    await request(janeCookie, 'jane@newjob.org')
    const link = await seedMagicLink(jane)
    expect(link).toBeTruthy()
    const r = await press(notMeTokenSentTo('jane@oldjob.org'))
    expect(r.headers.get('Set-Cookie')).toBeNull()
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM magic_links WHERE user_id = ?').bind(jane).first<{ n: number }>())!.n).toBe(1)
  })
})

describe('rate limits', () => {
  it('apply per IP to both calls', async () => {
    const limited = { LOGIN_RATE_LIMITER: { limit: async () => ({ success: false }) } }
    expect((await call('/api/auth/email-change/not-me/status', { method: 'POST', body: '{"token":"x"}' }, limited)).status).toBe(429)
    expect((await press('x', limited)).status).toBe(429)
  })
})

describe('demo', () => {
  it('blocks the press on a demo instance, but still answers the read-only status call', async () => {
    await request(janeCookie, 'jane@newjob.org')
    const token = notMeTokenSentTo('jane@oldjob.org')
    useBinding()
    const demo = { DEMO_MODE: 'true' }
    expect((await press(token, demo)).status).toBe(403)
    expect(await sessionCount(jane)).toBe(1)
    expect(sent).toHaveLength(0)
    const r = await call('/api/auth/email-change/not-me/status', { method: 'POST', body: JSON.stringify({ token }) }, demo)
    expect(r).toMatchObject({ status: 200, body: { status: 'valid' } })
  })
})

// The report to the admins goes out by the account purpose (#707): each alert
// is its own send, so a batch of them can end differently, and each falls back
// to the second provider and counts to the provider that sent it.
describe('the report to the admins, by purpose', () => {
  /** A Cloudflare binding that fails for the addresses `fails` names (a suppression code is permanent, any other code is an outage), and delivers the rest. It becomes the binding `sent` reads. */
  function binding(fails: (to: string) => string | null) {
    return useBinding((m) => {
      const code = fails([m.to].flat()[0])
      return code === 'E_RECIPIENT_SUPPRESSED' ? 'suppressed' : code ? 'down' : 'ok'
    })
  }
  const withResend = { RESEND_API_KEY: 'test-api-key' }
  const resendBodies = (resend: ReturnType<typeof stubResend>) => resend.calls.map(c => c.body)
  async function stats() {
    return Object.fromEntries((await getDb(env.DB).select().from(emailSendStats).all()).map(r => [r.provider, r]))
  }
  let token: string

  beforeEach(async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await request(janeCookie, 'jane@newjob.org')
    token = notMeTokenSentTo('jane@oldjob.org')
    useBinding()
    await env.DB.prepare('DELETE FROM email_send_stats').run()
  })
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

  it('sends every alert through Resend when Cloudflare is down, and counts each attempt to its own provider', async () => {
    const resend = stubResend()
    const r = await press(token, { EMAIL: binding(() => 'E_INTERNAL_SERVER_ERROR').binding, ...withResend })
    expect(r.body).toEqual({ ok: true, alerted: true, cancelled: true })
    const bodies = resendBodies(resend)
    expect(bodies.map(b => b.to[0]).sort()).toEqual(['ada@org.org', 'olive@org.org'])
    expect(bodies.every(b => b.subject.includes("didn't change their sign-in email"))).toBe(true)
    const by = await stats()
    expect(by.cloudflare).toMatchObject({ sent: 0, failed: 2, suppressed: 0 })
    expect(by.resend).toMatchObject({ sent: 2, failed: 0 })
  })

  it('reports a mixed batch per alert: one rescued, one undeliverable, and the report still counts as alerted', async () => {
    const resend = stubResend()
    const mail = binding(to => (to === 'olive@org.org' ? 'E_RECIPIENT_SUPPRESSED' : to === 'ada@org.org' ? 'E_INTERNAL_SERVER_ERROR' : null))
    const r = await press(token, { EMAIL: mail.binding, ...withResend })
    expect(r.body).toEqual({ ok: true, alerted: true, cancelled: true })
    // The suppressed owner is not retried through Resend. The admin's alert is.
    expect(resendBodies(resend).map(b => b.to[0])).toEqual(['ada@org.org'])
    const by = await stats()
    expect(by.cloudflare).toMatchObject({ sent: 0, failed: 1, suppressed: 1 })
    expect(by.resend).toMatchObject({ sent: 1, failed: 0 })
  })

  it('still signs the member out, and says nobody was alerted, when both providers are down for every alert', async () => {
    const resend = stubResend('down', { status: 500, body: 'upstream error' })
    const r = await press(token, { EMAIL: binding(() => 'E_INTERNAL_SERVER_ERROR').binding, ...withResend })
    expect(r).toMatchObject({ status: 200, body: { ok: true, alerted: false } })
    expect(await sessionCount(jane)).toBe(0)
    expect(resend.calls).toHaveLength(2)
    const by = await stats()
    expect(by.cloudflare).toMatchObject({ failed: 2 })
    expect(by.resend).toMatchObject({ failed: 2 })
  })

  it('sends no alert from a demo instance, by the purpose\'s rule alone', async () => {
    const resend = stubResend()
    const mail = binding(() => null)
    const r = await reportNotMe(testEnv({ EMAIL: mail.binding, DEMO_MODE: 'true', ...withResend }) as never, getDb(env.DB), token, { userAgent: null, ipCountry: null })
    expect(r).toMatchObject({ ok: true, alerted: false })
    expect(mail.sent).toHaveLength(0)
    expect(resend.calls).toHaveLength(0)
    expect(await getDb(env.DB).select().from(emailSendStats).all()).toHaveLength(0)
  })
})
