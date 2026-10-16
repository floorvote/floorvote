import { env } from 'cloudflare:test'
import { describe, it, expect, beforeEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { app } from '../../src/index'
import { resetDb, applyMigrations, seedUser, seedSession, seedMagicLink, seedAuthEvent } from '../helpers'
import { getDb } from '../../src/db/client'
import { users, sessions, authEvents, emailChanges } from '../../src/db/schema'
import { _resetSuperadminAllowlistCache } from '../../src/lib/superadminCentral'

// An admin changes an active member's email (#416). It goes through the same
// request and commit as the member's own change (lib/emailChange.ts): the
// change takes effect only when confirmed from the new address, the old address
// hears twice, and the commit ends every one of the member's sessions. Outgoing
// email is captured from a fake Cloudflare EMAIL binding.

type Sent = { to: string[]; subject: string; html: string; text: string }

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

let sent: Sent[]
const superadmins = ['root@operator.example']

function testEnv(extra: Record<string, unknown> = {}) {
  return {
    ...env,
    EMAIL_PROVIDER: 'cloudflare',
    EMAIL: { send: async (m: Sent) => { sent.push(m); return { messageId: `m-${sent.length}` } } },
    CENTRAL: {
      fetch: async (req: Request) => {
        if (new URL(req.url).pathname === '/api/admin/superadmin/emails') {
          return new Response(JSON.stringify({ hashes: await Promise.all(superadmins.map(sha256Hex)) }))
        }
        return new Response('not found', { status: 404 })
      },
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

const changeFor = (cookie: string, memberId: string, email: unknown, extraEnv: Record<string, unknown> = {}) =>
  call(`/api/admin/members/${memberId}/change-email`, { method: 'POST', cookie, body: JSON.stringify({ email }) }, extraEnv)
const status = (token: string) => call('/api/auth/email-change/status', { method: 'POST', body: JSON.stringify({ token }) })
const confirm = (token: string) => call('/api/auth/email-change/confirm', { method: 'POST', body: JSON.stringify({ token }) })
const pressNotMe = (token: string) => call('/api/auth/email-change/not-me', { method: 'POST', body: JSON.stringify({ token }) })

const CONFIRM_LINK = /\/auth\/confirm-email\?token=([0-9a-f]+)/
const NOT_ME_LINK = /\/auth\/not-me\?token=([0-9a-f]+)/

function linkSentTo(re: RegExp, to: string, nth?: number): string {
  const mails = sent.filter(m => m.to.includes(to) && re.test(m.text))
  const mail = nth === undefined ? mails[mails.length - 1] : mails[nth]
  if (!mail) throw new Error(`no matching link sent to ${to}`)
  return mail.text.match(re)![1]
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
const pending = () => getDb(env.DB).select().from(emailChanges).all()
async function signIn(token: string) {
  return app.request('/api/auth/verify', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }),
  }, testEnv())
}

let owner: string
let ownerCookie: string
let admin: string
let adminCookie: string
let jane: string

const NEW = 'jane@newjob.org'

beforeEach(async () => {
  await resetDb()
  await applyMigrations()
  _resetSuperadminAllowlistCache()
  sent = []
  owner = await seedUser({ role: 'owner', email: 'olive@org.org', name: 'Olive Owner' })
  ownerCookie = `session=${await seedSession(owner)}`
  admin = await seedUser({ role: 'admin', email: 'ada@org.org', name: 'Ada Admin' })
  adminCookie = `session=${await seedSession(admin)}`
  jane = await seedUser({ email: 'jane@oldjob.org', name: 'Jane Doe' })
})

describe('POST /admin/members/:id/change-email for an active member: who may', () => {
  it('lets an admin ask for a Standard member, answering that nothing has changed yet', async () => {
    const r = await changeFor(adminCookie, jane, NEW)
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ ok: true, email: NEW, pending: true })
    expect((await member(jane)).email).toBe('jane@oldjob.org')
    expect(await pending()).toHaveLength(1)
  })

  it('lets an owner ask for a Standard member, an admin, and another owner', async () => {
    const other = await seedUser({ role: 'owner', email: 'otto@org.org' })
    for (const [id, email] of [[jane, NEW], [admin, 'ada@new.org'], [other, 'otto@new.org']] as const) {
      const r = await changeFor(ownerCookie, id, email)
      expect(r.status).toBe(200)
      expect(r.body).toEqual({ ok: true, email, pending: true })
    }
  })

  it.each([
    ['an admin', 'admin', "Only owners can change an admin's address"],
    ['an owner', 'owner', "Only owners can change an owner's address"],
  ] as const)('refuses an admin who asks for %s, and sends nothing', async (_l, role, error) => {
    const target = await seedUser({ role, email: 'target@org.org' })
    const r = await changeFor(adminCookie, target, 'target@new.org')
    expect(r).toMatchObject({ status: 403, body: { error } })
    expect(await pending()).toHaveLength(0)
    expect(sent).toHaveLength(0)
    expect((await member(target)).email).toBe('target@org.org')
  })

  it("refuses everyone for a superadmin account, owners included", async () => {
    const root = await seedUser({ email: 'root@operator.example', role: 'member' })
    for (const cookie of [adminCookie, ownerCookie]) {
      const r = await changeFor(cookie, root, 'root@elsewhere.org')
      expect(r).toMatchObject({ status: 403, body: { error: "This account's address is managed centrally, so it can't be changed here." } })
    }
    const rootAdmin = await seedUser({ email: 'Root@Operator.example', role: 'admin' })
    expect((await changeFor(ownerCookie, rootAdmin, 'root@elsewhere.org')).status).toBe(403)
    expect(await pending()).toHaveLength(0)
    expect(sent).toHaveLength(0)
  })

  it('refuses a superadmin who is still a pending invite, because they only ever sign in by dashboard login', async () => {
    // Invited, never used a sign-in link: the pending-invite shortcut must not reach them.
    const root = await seedUser({ email: 'root@operator.example', role: 'member', invitedBy: owner })
    await seedSession(root)
    for (const cookie of [adminCookie, ownerCookie]) {
      const r = await changeFor(cookie, root, 'someone@elsewhere.org')
      expect(r).toMatchObject({ status: 403, body: { error: "This account's address is managed centrally, so it can't be changed here." } })
    }
    expect((await member(root)).email).toBe('root@operator.example')
    expect(sent).toHaveLength(0)
  })

  it('refuses a plain member, who is no admin', async () => {
    const r = await changeFor(`session=${await seedSession(jane)}`, jane, NEW)
    expect(r.status).toBe(403)
    expect(await pending()).toHaveLength(0)
  })

  it("refuses an admin's own address, which belongs on their Account page", async () => {
    expect((await changeFor(ownerCookie, owner, 'olive@new.org')).status).toBe(400)
    expect(await pending()).toHaveLength(0)
  })

  it('refuses a deactivated member', async () => {
    const gone = await seedUser({ email: 'gone@org.org', deactivatedAt: '2026-01-01 00:00:00' })
    const r = await changeFor(adminCookie, gone, 'gone@new.org')
    expect(r.status).toBe(400)
    expect(await pending()).toHaveLength(0)
  })

  it('is blocked on a demo instance, and sends nothing', async () => {
    const r = await changeFor(adminCookie, jane, NEW, { DEMO_MODE: 'true' })
    expect(r.status).toBe(403)
    expect(sent).toHaveLength(0)
  })
})

describe('the request: same rules as a member asking', () => {
  it('sends the confirmation to the new address and an admin-worded, masked notice to the old one', async () => {
    await changeFor(adminCookie, jane, NEW)
    const toNew = sent.filter(m => m.to.includes(NEW))
    expect(toNew).toHaveLength(1)
    expect(toNew[0].html).toContain('Confirm new email')
    const toOld = sent.filter(m => m.to.includes('jane@oldjob.org'))
    expect(toOld).toHaveLength(1)
    expect(toOld[0].text).toContain('An admin asked to change the sign-in email')
    expect(toOld[0].text).toContain("If you asked an admin to make this change, you don't need to do anything.")
    expect(toOld[0].text).not.toContain('If you asked for this')
    expect(toOld[0].html).toContain('j***@newjob.org')
    expect(toOld[0].html).not.toContain(NEW)
    expect(toOld[0].html).toContain("This wasn't me")
  })

  it('records the admin as the requester and as the actor', async () => {
    await changeFor(adminCookie, jane, NEW)
    const [row] = await pending()
    expect(row).toMatchObject({ userId: jane, requestedBy: admin, requestingSessionId: null })
    const [ev] = (await eventsFor(jane)).filter(e => e.event === 'email_change_requested')
    expect(ev).toMatchObject({ email: NEW, reason: 'jane@oldjob.org', actorId: admin })
  })

  it.each([
    ['not an address', 'jane at newjob', 400, "That doesn't look like a valid email address."],
    ['the current address', 'JANE@oldjob.org', 400, "That's already their address. Check it for a typo."],
    ["central's superadmin list", 'root@operator.example', 400, "That address can't be used here."],
  ])('refuses %s', async (_l, email, code, error) => {
    const r = await changeFor(adminCookie, jane, email)
    expect(r).toMatchObject({ status: code, body: { error } })
    expect(sent).toHaveLength(0)
  })

  it('refuses an address another member uses, deactivated members included', async () => {
    await seedUser({ email: 'Bob@Shared.org', deactivatedAt: '2026-01-01 00:00:00' })
    const r = await changeFor(adminCookie, jane, 'bob@shared.org')
    expect(r).toMatchObject({ status: 409, body: { error: 'That address is already used by another member.' } })
  })

  it('refuses an address that bounced before', async () => {
    await seedAuthEvent(jane, 'email_bounced', { email: 'gone@bounce.org' })
    expect((await changeFor(adminCookie, jane, 'gone@bounce.org')).status).toBe(400)
    expect(sent).toHaveLength(0)
  })

  it('keeps one pending change: a second request replaces the first', async () => {
    await changeFor(adminCookie, jane, 'jane@first.org')
    const first = linkSentTo(CONFIRM_LINK, 'jane@first.org')
    await changeFor(ownerCookie, jane, 'jane@second.org')
    expect(await pending()).toHaveLength(1)
    expect((await confirm(first)).status).toBe(404)
  })

  it('says so, naming no admin, when the confirmation cannot be sent', async () => {
    const failing = { send: async () => { throw new Error('provider down') } }
    const r = await changeFor(adminCookie, jane, NEW, { EMAIL: failing })
    expect(r.status).toBe(502)
    expect(await pending()).toHaveLength(0)
  })
})

describe('the request: send limits', () => {
  it("counts against the member's three a day from admins, whichever admin asks, in the admin's words", async () => {
    for (const n of [1, 2, 3]) expect((await changeFor(adminCookie, jane, `jane${n}@newjob.org`)).status).toBe(200)
    const before = sent.length
    const r = await changeFor(ownerCookie, jane, 'jane4@newjob.org')
    expect(r).toMatchObject({ status: 429, body: { error: "A change to this member's email was requested three times in the past day. Please try again tomorrow." } })
    expect(sent).toHaveLength(before)
  })

  it("applies the admin's hourly cap across all members", async () => {
    for (let i = 0; i < 50; i++) await seedAuthEvent(owner, 'email_change_requested', { email: `x${i}@x.org`, actorId: admin })
    const r = await changeFor(adminCookie, jane, NEW)
    // Email-change requests are tallied apart from invites and sign-in links, and say so.
    expect(r).toMatchObject({ status: 429, body: { error: "You've asked to change a lot of members' email addresses in the past hour. Please wait a little while before asking again." } })
    expect(sent).toHaveLength(0)
    expect(await pending()).toHaveLength(0)
  })

  it('applies the per-address hourly cap, whichever member the address is aimed at', async () => {
    for (let i = 0; i < 5; i++) await seedAuthEvent(owner, 'email_change_requested', { email: NEW, actorId: owner })
    const r = await changeFor(adminCookie, jane, NEW)
    expect(r.status).toBe(429)
    expect(r.body.error).toBe('That address was sent several email-change confirmations in the past hour. Ask the person to check their spam folder, or try again in a little while.')
    expect(sent).toHaveLength(0)
  })

  it('does not count a refused request', async () => {
    for (let i = 0; i < 3; i++) await changeFor(adminCookie, jane, 'not an address')
    expect((await changeFor(adminCookie, jane, NEW)).status).toBe(200)
  })
})

describe('confirming an admin-initiated change', () => {
  let oldLink: string
  let token: string

  beforeEach(async () => {
    await seedSession(jane)
    await seedSession(jane)
    oldLink = await seedMagicLink(jane)
    await changeFor(adminCookie, jane, NEW)
    token = linkSentTo(CONFIRM_LINK, NEW)
    sent = []
  })

  it('takes effect only after the new address confirms: loading the page changes nothing', async () => {
    const r = await status(token)
    expect(r.body).toEqual({ status: 'valid', email: NEW, byAdmin: true })
    expect((await member(jane)).email).toBe('jane@oldjob.org')
    expect(await sessionCount(jane)).toBe(2)
    expect(await pending()).toHaveLength(1)
    expect(sent).toHaveLength(0)
  })

  it('commits: the new address, old links dead, every session ended, and nobody signed in', async () => {
    const r = await confirm(token)
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ ok: true, email: NEW, byAdmin: true })
    expect(r.headers.get('Set-Cookie')).toBeNull()

    expect((await member(jane)).email).toBe(NEW)
    expect((await signIn(oldLink)).status).toBe(400)
    expect(await sessionCount(jane)).toBe(0)
    expect(await pending()).toHaveLength(0)
  })

  it("leaves the admin's own session alone", async () => {
    await confirm(token)
    const adminSession = await getDb(env.DB).select().from(sessions).where(eq(sessions.userId, admin)).all()
    expect(adminSession).toHaveLength(1)
  })

  it('records the confirmation with the admin as actor', async () => {
    await confirm(token)
    const [ev] = (await eventsFor(jane)).filter(e => e.event === 'email_change_confirmed')
    expect(ev).toMatchObject({ email: NEW, reason: 'jane@oldjob.org', actorId: admin })
  })

  it('tells the old address the second time, masked, with no device kept', async () => {
    await confirm(token)
    const toOld = sent.filter(m => m.to.includes('jane@oldjob.org'))
    expect(toOld).toHaveLength(1)
    expect(toOld[0].subject).toBe('Your FloorVote sign-in email was changed')
    expect(toOld[0].text).toContain('j***@newjob.org')
    expect(toOld[0].text).toContain('signed out everywhere.')
    expect(toOld[0].text).not.toContain('except the device')
    expect(toOld[0].text).toContain("If you asked an admin to make this change, you don't need to do anything.")
    expect(toOld[0].text).toMatch(NOT_ME_LINK)
  })

  it("shows the member the admin's name in their history, and admins the same in Member history", async () => {
    await confirm(token)
    const adminView = await call(`/api/admin/members/${jane}/auth-events`, { cookie: adminCookie })
    const steps = (adminView.body.events as { event: string; actorId: string; actorName: string }[]).filter(e => e.event.startsWith('email_change_'))
    expect(steps.map(e => [e.event, e.actorId, e.actorName])).toEqual(expect.arrayContaining([
      ['email_change_requested', admin, 'Ada Admin'],
      ['email_change_confirmed', admin, 'Ada Admin'],
    ]))
  })

  it("refuses with the admin's wording when the link has expired", async () => {
    await env.DB.prepare("UPDATE email_changes SET expires_at = datetime('now', '-1 hour')").run()
    expect((await status(token)).body).toEqual({ status: 'expired', byAdmin: true })
    const r = await confirm(token)
    expect(r.status).toBe(410)
    expect(r.body.error).toBe('This link has expired. Ask the admin who requested the change to request it again.')
  })

  it('refuses, and cancels, once the account has changed since', async () => {
    await getDb(env.DB).update(users).set({ email: 'jane@somewhere.org' }).where(eq(users.id, jane))
    const r = await confirm(token)
    expect(r.status).toBe(409)
    expect(r.body.error).toContain('Ask the admin who requested it to request it again.')
    expect(await pending()).toHaveLength(0)
  })

  it('refuses, and cancels, when the requesting admin has since been demoted, deactivated, or outranked', async () => {
    const cases: [string, () => Promise<void>][] = [
      ['demoted', async () => { await getDb(env.DB).update(users).set({ role: 'member' }).where(eq(users.id, admin)) }],
      ['deactivated', async () => { await getDb(env.DB).update(users).set({ deactivatedAt: '2026-01-01 00:00:00' }).where(eq(users.id, admin)) }],
      ['outranked', async () => { await getDb(env.DB).update(users).set({ role: 'admin' }).where(eq(users.id, jane)) }],
    ]
    for (const [, undo] of cases) {
      await getDb(env.DB).update(users).set({ role: 'admin', deactivatedAt: null }).where(eq(users.id, admin))
      await getDb(env.DB).update(users).set({ role: 'member' }).where(eq(users.id, jane))
      // Three a day per member: each case starts with a clean allowance.
      await env.DB.prepare("DELETE FROM auth_events WHERE event = 'email_change_requested'").run()
      expect((await changeFor(adminCookie, jane, NEW)).status).toBe(200)
      const t = linkSentTo(CONFIRM_LINK, NEW)
      await undo()
      const r = await confirm(t)
      expect(r.status).toBe(409)
      expect((await member(jane)).email).toBe('jane@oldjob.org')
      expect(await pending()).toHaveLength(0)
    }
  })

  it("keeps an owner's standing: an owner's change still commits after the owner asks for an admin", async () => {
    await changeFor(ownerCookie, admin, 'ada@new.org')
    const t = linkSentTo(CONFIRM_LINK, 'ada@new.org')
    expect((await confirm(t)).status).toBe(200)
    expect((await member(admin)).email).toBe('ada@new.org')
  })

  it("refuses to commit once the member's address has joined central's superadmin list", async () => {
    await getDb(env.DB).update(users).set({ email: 'root@operator.example' }).where(eq(users.id, jane))
    await env.DB.prepare("UPDATE email_changes SET old_email = 'root@operator.example'").run()
    const r = await confirm(token)
    expect(r.status).toBe(403)
    expect(r.body.error).toBe("This account's address is managed centrally, so it can't be changed here.")
  })
})

describe('"This wasn\'t me" and an admin-initiated change', () => {
  it('ends every session but leaves the admin-initiated change pending, and still confirmable', async () => {
    await seedSession(jane)
    await seedSession(jane)
    await changeFor(adminCookie, jane, NEW)
    const confirmToken = linkSentTo(CONFIRM_LINK, NEW)
    const notMe = linkSentTo(NOT_ME_LINK, 'jane@oldjob.org')

    const r = await pressNotMe(notMe)
    expect(r.status).toBe(200)
    expect(await sessionCount(jane)).toBe(0)
    expect(await pending()).toHaveLength(1)
    expect((await eventsFor(jane)).filter(e => e.event === 'email_change_cancelled')).toHaveLength(0)

    expect((await confirm(confirmToken)).status).toBe(200)
    expect((await member(jane)).email).toBe(NEW)
  })

  it("still cancels the member's own change, so the admin's rule is the only exception", async () => {
    const janeCookie = `session=${await seedSession(jane)}`
    await call('/api/users/me/email-change', { method: 'POST', cookie: janeCookie, body: JSON.stringify({ email: 'jane@mine.org' }) })
    const r = await pressNotMe(linkSentTo(NOT_ME_LINK, 'jane@oldjob.org'))
    expect(r.status).toBe(200)
    expect(await pending()).toHaveLength(0)
  })
})

describe("an admin's change and the member's own requests", () => {
  // A takeover: someone else moved Jane's account to their own address and
  // signs back in after "This wasn't me". An admin asks to move it back to the
  // address Jane really holds. The session's own requests must neither cancel
  // that change nor use up the admins' allowance for her.
  const REAL = 'jane@real.org'
  const ownRequest = (cookie: string, email: string) =>
    call('/api/users/me/email-change', { method: 'POST', cookie, body: JSON.stringify({ email }) })
  let takenCookie: string

  beforeEach(async () => {
    takenCookie = `session=${await seedSession(jane)}`
  })

  it("refuses the member's own request while an admin's change is pending, and leaves the admin's link working", async () => {
    expect((await changeFor(adminCookie, jane, REAL)).status).toBe(200)
    const adminLink = linkSentTo(CONFIRM_LINK, REAL)
    sent = []

    for (const email of ['jane@thief.org', 'jane@thief2.org']) {
      const r = await ownRequest(takenCookie, email)
      expect(r).toMatchObject({ status: 409, body: { error: 'An admin has an email change pending for your account.' } })
    }
    expect(sent).toHaveLength(0)
    expect(await pending()).toMatchObject([{ requestedBy: admin, newEmail: REAL }])
    expect((await eventsFor(jane)).filter(e => e.event === 'email_change_cancelled')).toHaveLength(0)

    // The refused requests used none of anyone's allowance: the admin can still re-ask.
    expect((await changeFor(adminCookie, jane, REAL)).status).toBe(200)
    expect((await confirm(linkSentTo(CONFIRM_LINK, REAL))).status).toBe(200)
    expect((await member(jane)).email).toBe(REAL)
    expect((await confirm(adminLink)).status).toBe(404)
  })

  it("refuses the member's own request when an admin's change lands while it is being checked", async () => {
    // The admin's request arrives between the member's checks and their write:
    // here, while the member's new address is looked up on the bounce list.
    const central = (testEnv() as unknown as { CENTRAL: { emailSuppressionMany: (e: string[]) => Promise<unknown> } }).CENTRAL
    const racing = {
      ...central,
      emailSuppressionMany: async (emails: string[]) => {
        if (emails.includes('jane@thief.org')) expect((await changeFor(adminCookie, jane, REAL)).status).toBe(200)
        return central.emailSuppressionMany(emails)
      },
    }
    const r = await call('/api/users/me/email-change', {
      method: 'POST', cookie: takenCookie, body: JSON.stringify({ email: 'jane@thief.org' }),
    }, { CENTRAL: racing })
    expect(r).toMatchObject({ status: 409, body: { error: 'An admin has an email change pending for your account.' } })
    expect(await pending()).toMatchObject([{ requestedBy: admin, newEmail: REAL }])
    expect(sent.filter(m => m.to.includes('jane@thief.org'))).toHaveLength(0)
    const requested = (await eventsFor(jane)).filter(e => e.event === 'email_change_requested')
    expect(requested.map(e => e.actorId)).toEqual([admin])
    expect((await confirm(linkSentTo(CONFIRM_LINK, REAL))).status).toBe(200)
  })

  it("does not count the member's own requests against the admins' three a day", async () => {
    for (const n of [1, 2, 3]) expect((await ownRequest(takenCookie, `jane${n}@thief.org`)).status).toBe(200)
    expect((await ownRequest(takenCookie, 'jane4@thief.org')).status).toBe(429)
    const r = await changeFor(adminCookie, jane, REAL)
    expect(r.status).toBe(200)
    expect(await pending()).toMatchObject([{ requestedBy: admin, newEmail: REAL }])
  })

  it("does not count admins' requests against the member's three, and an expired admin change no longer blocks", async () => {
    for (const n of [1, 2, 3]) expect((await changeFor(adminCookie, jane, `jane${n}@real.org`)).status).toBe(200)
    await env.DB.prepare("UPDATE email_changes SET expires_at = datetime('now', '-1 hour')").run()
    const r = await ownRequest(takenCookie, 'jane@mine.org')
    expect(r.status).toBe(200)
    expect(await pending()).toMatchObject([{ requestedBy: jane, newEmail: 'jane@mine.org' }])
  })
})

describe('pending invites', () => {
  it('keep today\'s behavior: the address changes at once, with a new invite and no confirmation step', async () => {
    const invited = await seedUser({ email: 'jane@exmaple.com' })
    await getDb(env.DB).update(users).set({ invitedBy: admin }).where(eq(users.id, invited))
    const r = await changeFor(adminCookie, invited, 'jane@example.com')
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ ok: true, email: 'jane@example.com' })
    expect((await member(invited)).email).toBe('jane@example.com')
    expect(await pending()).toHaveLength(0)
    expect((await eventsFor(invited)).filter(e => e.event === 'email_changed')).toHaveLength(1)
  })
})
