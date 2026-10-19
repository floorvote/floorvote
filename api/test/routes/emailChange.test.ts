import { env } from 'cloudflare:test'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { app } from '../../src/index'
import { resetDb, applyMigrations, seedUser, seedSession, seedMagicLink, seedAuthEvent } from '../helpers'
import { getDb } from '../../src/db/client'
import { users, sessions, authEvents, emailChanges, emailSendStats } from '../../src/db/schema'
import { requestEmailChange, confirmEmailChange, EMAIL_CHANGE_ERRORS } from '../../src/lib/emailChange'
import { _resetSuperadminAllowlistCache } from '../../src/lib/superadminCentral'
import { hashToken } from '../../src/lib/crypto'
import { fakeBinding, stubResend } from '../../../shared/emailTestKit'

// Self-service email change (#414): request from Profile, confirm from the new
// inbox, and the notices to the old address. Outgoing email is captured from a
// fake Cloudflare EMAIL binding, so each test reads the messages that would
// have gone out.

type Sent = { to: string[]; subject: string; html: string; text: string }

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

// The binding every request sends through, and the messages it accepted. A test
// that needs a binding with another answer calls `useBinding`, which makes it the
// one `sent` reads.
let cf: ReturnType<typeof fakeBinding>
let sent: Sent[]
function useBinding(outcomes?: Parameters<typeof fakeBinding>[0]) {
  cf = fakeBinding(outcomes)
  sent = cf.delivered as unknown as Sent[]
  return cf
}
let superadmins: string[]
let suppressed: string[]
let centralDown: boolean

function testEnv(extra: Record<string, unknown> = {}) {
  return {
    ...env,
    EMAIL_PROVIDER: 'cloudflare',
    EMAIL: cf.binding,
    CENTRAL: {
      // The superadmin allowlist, as hashes, the way central serves it.
      fetch: async (req: Request) => {
        if (new URL(req.url).pathname === '/api/admin/superadmin/emails') {
          if (centralDown) return new Response('unavailable', { status: 503 })
          return new Response(JSON.stringify({ hashes: await Promise.all(superadmins.map(sha256Hex)) }))
        }
        return new Response('not found', { status: 404 })
      },
      emailSuppressionMany: async (emails: string[]) =>
        Object.fromEntries(emails.map(e => [e, { suppressed: suppressed.includes(e) }])),
    },
    ...extra,
  } as unknown as typeof env
}

type Reply = { status: number; body: Record<string, unknown>; headers: Headers }

async function call(path: string, init: RequestInit & { cookie?: string } = {}, extraEnv: Record<string, unknown> = {}): Promise<Reply> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (init.cookie) headers.Cookie = init.cookie
  const res = await app.request(path, { ...init, headers: { ...headers, ...(init.headers as Record<string, string> ?? {}) } }, testEnv(extraEnv))
  return { status: res.status, body: await res.json() as Record<string, unknown>, headers: res.headers }
}

const request = (cookie: string, email: unknown, extra: Record<string, unknown> = {}, extraEnv: Record<string, unknown> = {}) =>
  call('/api/users/me/email-change', { method: 'POST', cookie, body: JSON.stringify({ email, ...extra }) }, extraEnv)

const status = (token: string) =>
  call('/api/auth/email-change/status', { method: 'POST', body: JSON.stringify({ token }) })

const confirm = (token: string) =>
  call('/api/auth/email-change/confirm', { method: 'POST', body: JSON.stringify({ token }) })

const LINK = /\/auth\/confirm-email\?token=([0-9a-f]+)/

/** The raw token from the confirmation link in an email sent to `to`: the last one, or the `nth` (from 0). */
function tokenSentTo(to: string, nth?: number): string {
  const mails = sent.filter(m => m.to.includes(to) && LINK.test(m.text))
  const mail = nth === undefined ? mails[mails.length - 1] : mails[nth]
  if (!mail) throw new Error(`no confirmation link sent to ${to}`)
  return mail.text.match(LINK)![1]
}

async function member(id: string) {
  return (await getDb(env.DB).select().from(users).where(eq(users.id, id)).get())!
}

async function eventsFor(id: string) {
  return getDb(env.DB).select().from(authEvents).where(eq(authEvents.userId, id)).all()
}

async function signedInAs(userId: string): Promise<boolean> {
  return (await getDb(env.DB).select().from(sessions).where(eq(sessions.userId, userId)).all()).length > 0
}

async function sessionAlive(rawToken: string): Promise<boolean> {
  const row = await getDb(env.DB).select().from(sessions).where(eq(sessions.tokenHash, await hashToken(rawToken))).get()
  return !!row
}

async function signIn(token: string) {
  return app.request('/api/auth/verify', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }),
  }, testEnv())
}

let jane: string
let janeSession: string
let janeCookie: string

beforeEach(async () => {
  await resetDb()
  await applyMigrations()
  _resetSuperadminAllowlistCache()
  useBinding()
  superadmins = ['root@operator.example']
  suppressed = []
  centralDown = false
  jane = await seedUser({ email: 'jane@oldjob.org', name: 'Jane Doe' })
  janeSession = await seedSession(jane)
  janeCookie = `session=${janeSession}`
})

describe('POST /users/me/email-change: request', () => {
  it('sends a confirmation to the new address and a masked notice to the old one, and changes nothing yet', async () => {
    const r = await request(janeCookie, 'jane@newjob.org')
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ ok: true, email: 'jane@newjob.org' })

    expect((await member(jane)).email).toBe('jane@oldjob.org')

    const toNew = sent.filter(m => m.to.includes('jane@newjob.org'))
    expect(toNew).toHaveLength(1)
    expect(toNew[0].html).toContain('Confirm new email')
    expect(tokenSentTo('jane@newjob.org')).toMatch(/^[0-9a-f]{64}$/)

    const toOld = sent.filter(m => m.to.includes('jane@oldjob.org'))
    expect(toOld).toHaveLength(1)
    expect(toOld[0].html).toContain('j***@newjob.org')
    expect(toOld[0].html).not.toContain('jane@newjob.org')
    expect(toOld[0].text).not.toContain('jane@newjob.org')
    expect(toOld[0].html).toContain("This wasn't me")
  })

  it('stores the token hashed, never raw', async () => {
    await request(janeCookie, 'jane@newjob.org')
    const token = tokenSentTo('jane@newjob.org')
    const [row] = await getDb(env.DB).select().from(emailChanges).all()
    expect(row.tokenHash).toBe(await hashToken(token))
    expect(JSON.stringify(row)).not.toContain(token)
  })

  it('records the request with the member as actor and both addresses', async () => {
    await request(janeCookie, 'jane@newjob.org')
    const [ev] = (await eventsFor(jane)).filter(e => e.event === 'email_change_requested')
    expect(ev).toMatchObject({ email: 'jane@newjob.org', reason: 'jane@oldjob.org', actorId: jane })
  })

  it('requires a signed-in member', async () => {
    const r = await call('/api/users/me/email-change', { method: 'POST', body: JSON.stringify({ email: 'x@y.org' }) })
    expect(r.status).toBe(401)
    expect(sent).toHaveLength(0)
  })
})

describe('POST /users/me/email-change: validation', () => {
  it('lowercases and trims the new address', async () => {
    const r = await request(janeCookie, '  Jane@NewJob.ORG ')
    expect(r.body).toEqual({ ok: true, email: 'jane@newjob.org' })
  })

  it.each([
    ['not an address', 'jane at newjob', 400, "That doesn't look like a valid email address."],
    ['a non-ASCII look-alike', 'jаne@newjob.org', 400, "That doesn't look like a valid email address."],
    ['the current address, in another case', ' JANE@oldjob.org', 400, "That's already your email address."],
  ])('refuses %s', async (_label, email, code, error) => {
    const r = await request(janeCookie, email)
    expect(r.status).toBe(code)
    expect(r.body).toEqual({ error })
    expect(sent).toHaveLength(0)
  })

  it('refuses an address another member uses, ignoring case, deactivated members included', async () => {
    await seedUser({ email: 'Bob@Shared.org', deactivatedAt: '2026-01-01 00:00:00' })
    const r = await request(janeCookie, 'bob@shared.org')
    expect(r.status).toBe(409)
    expect(r.body).toEqual({ error: 'That address is already used by another member.' })
    expect(sent).toHaveLength(0)
  })

  it('refuses an address that bounced before, recorded here or on the provider list', async () => {
    await seedAuthEvent(jane, 'email_bounced', { email: 'gone@bounce.org' })
    suppressed = ['listed@bounce.org']
    for (const email of ['gone@bounce.org', 'listed@bounce.org']) {
      const r = await request(janeCookie, email)
      expect(r.status).toBe(400)
      expect(r.body.error).toBe('Email to that address has bounced before. Check it for a typo, or use a different address.')
    }
    expect(sent).toHaveLength(0)
  })

  it("refuses an address on central's superadmin list", async () => {
    const r = await request(janeCookie, 'Root@Operator.example')
    expect(r.status).toBe(400)
    expect(r.body).toEqual({ error: "That address can't be used here." })
  })

  it("refuses to change a superadmin account's address", async () => {
    const root = await seedUser({ email: 'root@operator.example', role: 'admin' })
    const r = await request(`session=${await seedSession(root)}`, 'root@elsewhere.org')
    expect(r.status).toBe(403)
    expect(r.body).toEqual({ error: "Your address is managed centrally, so it can't be changed here." })
    expect(sent).toHaveLength(0)
  })

  it("refuses, retryably, when central's superadmin list can't be read and nothing is cached", async () => {
    // A cold isolate during a central outage must not read as "not a superadmin".
    centralDown = true
    const root = await seedUser({ email: 'root@operator.example', role: 'admin' })
    for (const [cookie, email] of [[`session=${await seedSession(root)}`, 'root@elsewhere.org'], [janeCookie, 'root@operator.example']]) {
      const r = await request(cookie, email)
      expect(r).toMatchObject({ status: 503, body: { error: "Can't check this address right now. Try again in a few minutes." } })
    }
    expect(sent).toHaveLength(0)
    expect(await getDb(env.DB).select().from(emailChanges).all()).toHaveLength(0)
    expect((await eventsFor(jane)).filter(e => e.event === 'email_change_requested')).toHaveLength(0)
  })
})

describe('POST /users/me/email-change: limits', () => {
  const LIMIT = "You've asked to change your email three times in the past day. Please try again tomorrow."

  it('allows three requests a day, then refuses the fourth without sending', async () => {
    for (const n of [1, 2, 3]) expect((await request(janeCookie, `jane${n}@newjob.org`)).status).toBe(200)
    const before = sent.length
    const r = await request(janeCookie, 'jane4@newjob.org')
    expect(r.status).toBe(429)
    expect(r.body).toEqual({ error: LIMIT })
    expect(sent).toHaveLength(before)
  })

  it('counts only the past day', async () => {
    for (let i = 0; i < 3; i++) {
      await seedAuthEvent(jane, 'email_change_requested', { email: `old${i}@x.org`, createdAt: '2020-01-01 00:00:00' })
    }
    expect((await request(janeCookie, 'jane@newjob.org')).status).toBe(200)
  })

  it('does not count a refused request', async () => {
    for (let i = 0; i < 3; i++) await request(janeCookie, 'not an address')
    expect((await request(janeCookie, 'jane@newjob.org')).status).toBe(200)
  })

  it('applies the per-IP limit the sign-in form uses', async () => {
    const keys: string[] = []
    const limiter = { limit: async ({ key }: { key: string }) => { keys.push(key); return { success: false } } }
    const r = await request(janeCookie, 'jane@newjob.org', {}, { LOGIN_RATE_LIMITER: limiter })
    expect(r.status).toBe(429)
    expect(keys).toEqual(['email-change:unknown'])
    expect(sent).toHaveLength(0)
  })

  it('asks a signed-in member for no Turnstile token, even once Turnstile is configured: the session is the proof, the limits still apply', async () => {
    const siteverify = vi.spyOn(globalThis, 'fetch')
    try {
      const ok = await request(janeCookie, 'jane@newjob.org', {}, { TURNSTILE_SECRET_KEY: 'secret' })
      expect(ok.status).toBe(200)
      expect(sent.some(m => m.to.includes('jane@newjob.org'))).toBe(true)
      expect(siteverify).not.toHaveBeenCalledWith('https://challenges.cloudflare.com/turnstile/v0/siteverify', expect.anything())
    } finally {
      siteverify.mockRestore()
    }
  })

  it('still refuses an unauthenticated sign-in request without a token once Turnstile is configured', async () => {
    await seedUser({ email: 'someone@example.com' })
    const res = await call('/api/auth/magic-link', { method: 'POST', body: JSON.stringify({ email: 'someone@example.com' }) }, { TURNSTILE_SECRET_KEY: 'secret' })
    expect(res.status).toBe(403)
  })

  it('still refuses an unauthenticated email-change request', async () => {
    const res = await call('/api/users/me/email-change', { method: 'POST', body: JSON.stringify({ email: 'jane@newjob.org' }) }, { TURNSTILE_SECRET_KEY: 'secret' })
    expect(res.status).toBe(401)
  })

  it('keeps one pending change: a second request cancels the first', async () => {
    await request(janeCookie, 'jane@first.org')
    const first = tokenSentTo('jane@first.org')
    await request(janeCookie, 'jane@second.org')
    const second = tokenSentTo('jane@second.org')

    expect(await getDb(env.DB).select().from(emailChanges).all()).toHaveLength(1)
    expect((await status(first)).body).toEqual({ status: 'invalid' })
    expect((await confirm(first)).status).toBe(404)
    expect((await member(jane)).email).toBe('jane@oldjob.org')

    const [cancelled] = (await eventsFor(jane)).filter(e => e.event === 'email_change_cancelled')
    expect(cancelled).toMatchObject({ email: 'jane@first.org', reason: 'jane@oldjob.org', actorId: jane })

    expect((await confirm(second)).status).toBe(200)
    expect((await member(jane)).email).toBe('jane@second.org')
  })

  it("says so when the confirmation can't be sent, and leaves nothing to confirm", async () => {
    // Both providers are down: the binding throws, and the fallback (Resend) answers 500.
    stubResend('down', { status: 500, body: 'upstream error' })
    const r = await request(janeCookie, 'jane@newjob.org', {}, { EMAIL: fakeBinding('down').binding })
    expect(r.status).toBe(502)
    expect(r.body).toEqual({ error: "We couldn't send the confirmation email. Please try again in a little while." })
    expect(await getDb(env.DB).select().from(emailChanges).all()).toHaveLength(0)
  })
})

describe('confirming from the new address', () => {
  let otherSession: string
  let oldLink: string
  let token: string

  beforeEach(async () => {
    otherSession = await seedSession(jane)
    oldLink = await seedMagicLink(jane)
    await request(janeCookie, 'jane@newjob.org')
    token = tokenSentTo('jane@newjob.org')
    useBinding()
  })

  it('loading the link changes nothing', async () => {
    for (let i = 0; i < 2; i++) {
      const r = await status(token)
      expect(r.status).toBe(200)
      expect(r.body).toEqual({ status: 'valid', email: 'jane@newjob.org' })
      expect(r.headers.get('Referrer-Policy')).toBe('no-referrer')
      expect(r.headers.get('Set-Cookie')).toBeNull()
    }
    expect((await member(jane)).email).toBe('jane@oldjob.org')
    expect(await sessionAlive(otherSession)).toBe(true)
    expect(await getDb(env.DB).select().from(emailChanges).all()).toHaveLength(1)
    expect(sent).toHaveLength(0)
  })

  it('keeps the token out of the URL: the status call is a POST, and a GET with the token in the query is not served', async () => {
    const res = await app.request(`/api/auth/email-change/status?token=${token}`, {}, testEnv())
    expect(res.status).toBe(404)
    expect((await status(token)).body).toEqual({ status: 'valid', email: 'jane@newjob.org' })
  })

  it('pressing the button commits: new address, old links dead, other sessions ended, this one kept', async () => {
    const r = await confirm(token)
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ ok: true, email: 'jane@newjob.org' })
    expect(r.headers.get('Referrer-Policy')).toBe('no-referrer')
    // Never signs anyone in.
    expect(r.headers.get('Set-Cookie')).toBeNull()

    expect((await member(jane)).email).toBe('jane@newjob.org')
    expect((await signIn(oldLink)).status).toBe(400)
    expect(await sessionAlive(otherSession)).toBe(false)
    expect(await sessionAlive(janeSession)).toBe(true)

    const [ev] = (await eventsFor(jane)).filter(e => e.event === 'email_change_confirmed')
    expect(ev).toMatchObject({ email: 'jane@newjob.org', reason: 'jane@oldjob.org', actorId: jane })
  })

  it('tells the old address, with the new one masked', async () => {
    await confirm(token)
    expect(sent).toHaveLength(1)
    expect(sent[0].to).toEqual(['jane@oldjob.org'])
    expect(sent[0].subject).toBe('Your FloorVote sign-in email was changed')
    expect(sent[0].html).toContain('j***@newjob.org')
    expect(`${sent[0].html} ${sent[0].text}`).not.toContain('jane@newjob.org')
  })

  it('works once', async () => {
    expect((await confirm(token)).status).toBe(200)
    const again = await confirm(token)
    expect(again.status).toBe(404)
    expect(again.body).toEqual({ error: 'This link is no longer valid. It may have been used already, or replaced by a newer request.' })
    expect((await status(token)).body).toEqual({ status: 'invalid' })
  })

  it('works once even when two presses race', async () => {
    const results = await Promise.all([confirm(token), confirm(token)])
    expect(results.map(r => r.status).sort()).toEqual([200, 404])
    expect((await eventsFor(jane)).filter(e => e.event === 'email_change_confirmed')).toHaveLength(1)
  })

  it("a press that loses the race leaves the sign-ins made after the winner's commit alone", async () => {
    // Both presses pass their checks, then A's batch commits and a new session
    // and sign-in link arrive (the member signing in at the new address) before
    // B's batch runs. B updates nothing, so it must delete nothing.
    const parked: Array<() => void> = []
    const gated = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === 'batch') {
          return async (stmts: unknown[]) => {
            if (stmts.length === 4) await new Promise<void>(resolve => parked.push(resolve))
            return target.batch(stmts as never)
          }
        }
        const v = Reflect.get(target, prop)
        return typeof v === 'function' ? v.bind(target) : v
      },
    })
    const press = () => call('/api/auth/email-change/confirm', { method: 'POST', body: JSON.stringify({ token }) }, { DB: gated })
    const a = press()
    const b = press()
    const until = async (done: () => boolean | Promise<boolean>) => {
      for (let i = 0; i < 400 && !(await done()); i++) await new Promise(r => setTimeout(r, 5))
    }
    await until(() => parked.length === 2)
    expect(parked).toHaveLength(2)
    parked[0]()
    await until(async () => (await member(jane)).email === 'jane@newjob.org')
    const fresh = await seedSession(jane)
    const freshLink = await seedMagicLink(jane)
    parked[1]()
    const results = await Promise.all([a, b])
    expect(results.map(r => r.status)).toContain(200)
    expect(await sessionAlive(fresh)).toBe(true)
    expect((await signIn(freshLink)).status).toBe(200)
  })

  it('refuses an expired link', async () => {
    await env.DB.prepare("UPDATE email_changes SET expires_at = datetime('now', '-1 minute')").run()
    expect((await status(token)).body).toEqual({ status: 'expired' })
    const r = await confirm(token)
    expect(r.status).toBe(410)
    expect(r.body).toEqual({ error: 'This link has expired. Request the change again from your Account page.' })
    expect((await member(jane)).email).toBe('jane@oldjob.org')
  })

  it('refuses a made-up token', async () => {
    expect((await confirm('f'.repeat(64))).status).toBe(404)
    expect((await status('f'.repeat(64))).body).toEqual({ status: 'invalid' })
  })

  it.each([
    ['the address changed since the request', () => getDb(env.DB).update(users).set({ email: 'jane@third.org' }).where(eq(users.id, jane))],
    ['the member was deactivated', () => getDb(env.DB).update(users).set({ deactivatedAt: '2026-10-01 00:00:00' }).where(eq(users.id, jane))],
  ])('refuses a stale change (%s), and the token dies', async (_label, change) => {
    await change()
    const r = await confirm(token)
    expect(r.status).toBe(409)
    expect(r.body.error).toBe("This change can't be completed because the account changed after it was requested. Request it again from your Account page.")
    expect((await member(jane)).email).not.toBe('jane@newjob.org')
    expect((await confirm(token)).status).toBe(404)
    expect((await eventsFor(jane)).filter(e => e.event === 'email_change_cancelled')).toHaveLength(1)
  })

  it('re-checks every rule: an address taken since the request is refused plainly', async () => {
    await seedUser({ email: 'Jane@NewJob.org' })
    const r = await confirm(token)
    expect(r.status).toBe(409)
    expect(r.body).toEqual({ error: 'That address is already used by another member.' })
    expect((await member(jane)).email).toBe('jane@oldjob.org')
    expect(await sessionAlive(otherSession)).toBe(true)
  })

  it('re-checks every rule: an address that bounced or joined the superadmin list since is refused', async () => {
    suppressed = ['jane@newjob.org']
    expect((await confirm(token)).status).toBe(400)
    expect((await member(jane)).email).toBe('jane@oldjob.org')

    await request(janeCookie, 'jane@other.org')
    superadmins.push('jane@other.org')
    _resetSuperadminAllowlistCache()
    const r = await confirm(tokenSentTo('jane@other.org'))
    expect(r.status).toBe(400)
    expect(r.body).toEqual({ error: "That address can't be used here." })
  })

  it("refuses to commit once the member's own address has joined central's superadmin list", async () => {
    superadmins.push('jane@oldjob.org')
    _resetSuperadminAllowlistCache()
    const r = await confirm(token)
    expect(r.status).toBe(403)
    expect(r.body).toEqual({ error: "Your address is managed centrally, so it can't be changed here." })
    expect((await member(jane)).email).toBe('jane@oldjob.org')
    expect(await sessionAlive(otherSession)).toBe(true)
    expect((await confirm(token)).status).toBe(404)
  })

  it("refuses, retryably, when central's superadmin list can't be read, and keeps the change pending", async () => {
    _resetSuperadminAllowlistCache()
    centralDown = true
    const r = await confirm(token)
    expect(r).toMatchObject({ status: 503, body: { error: "Can't check this address right now. Try again in a few minutes." } })
    expect((await member(jane)).email).toBe('jane@oldjob.org')
    expect(await sessionAlive(otherSession)).toBe(true)

    centralDown = false
    _resetSuperadminAllowlistCache()
    expect((await confirm(token)).status).toBe(200)
    expect((await member(jane)).email).toBe('jane@newjob.org')
  })

  it('still reports success when the notice to the old address cannot be built after the commit', async () => {
    await env.DB.prepare('DROP TABLE association_config').run()
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const r = await confirm(token)
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ ok: true, email: 'jane@newjob.org' })
    expect((await member(jane)).email).toBe('jane@newjob.org')
    expect(errors).toHaveBeenCalled()
    errors.mockRestore()
  })

  it('maps a last-moment unique-constraint race to the same clear message', async () => {
    // Another member takes the address between the commit's checks and its
    // write: a trigger lands their row just before the update does.
    await env.DB.prepare(
      `CREATE TRIGGER racer BEFORE UPDATE OF email ON users WHEN NEW.email = 'jane@newjob.org'
       BEGIN INSERT INTO users (id, email) VALUES ('racer', 'jane@newjob.org'); END`,
    ).run()
    const r = await confirm(token)
    expect(r.status).toBe(409)
    expect(r.body).toEqual({ error: 'That address is already used by another member.' })
    expect((await member(jane)).email).toBe('jane@oldjob.org')
    expect(await sessionAlive(otherSession)).toBe(true)
    expect((await signIn(oldLink)).status).toBe(200)
  })

  it("cancels another member's pending change to the same address", async () => {
    const bob = await seedUser({ email: 'bob@oldjob.org' })
    await request(`session=${await seedSession(bob)}`, 'jane@newjob.org')
    const bobToken = tokenSentTo('jane@newjob.org')

    expect((await confirm(token)).status).toBe(200)
    expect((await confirm(bobToken)).status).toBe(404)
    expect((await member(bob)).email).toBe('bob@oldjob.org')
    expect((await eventsFor(bob)).filter(e => e.event === 'email_change_cancelled')).toHaveLength(1)
  })

  it('ends every session when the request came from no session', async () => {
    await env.DB.prepare('UPDATE email_changes SET requesting_session_id = NULL').run()
    await confirm(token)
    expect(await signedInAs(jane)).toBe(false)
  })
})

describe('history', () => {
  it("shows the request and the confirmation in the member's own account history", async () => {
    await request(janeCookie, 'jane@newjob.org')
    await confirm(tokenSentTo('jane@newjob.org'))
    const r = await call('/api/users/me/auth-events', { cookie: janeCookie })
    const events = r.body.events as { event: string; email: string; reason: string; actorId: string }[]
    const steps = events.filter(e => e.event.startsWith('email_change_')).map(e => [e.event, e.email, e.reason, e.actorId])
    expect(steps).toEqual(expect.arrayContaining([
      ['email_change_requested', 'jane@newjob.org', 'jane@oldjob.org', jane],
      ['email_change_confirmed', 'jane@newjob.org', 'jane@oldjob.org', jane],
    ]))
  })

  it("shows them in the admin's member history, naming who asked", async () => {
    const admin = await seedUser({ role: 'admin', email: 'ada@org.org' })
    await request(janeCookie, 'jane@newjob.org')
    const r = await call(`/api/admin/members/${jane}/auth-events`, { cookie: `session=${await seedSession(admin)}` })
    const [ev] = (r.body.events as { event: string; actorId: string; actorName: string }[]).filter(e => e.event === 'email_change_requested')
    expect(ev).toMatchObject({ actorId: jane, actorName: 'Jane Doe' })
  })
})

describe('demo', () => {
  it('blocks the request and the confirm on a demo instance', async () => {
    const demo = { DEMO_MODE: 'true' }
    expect((await request(janeCookie, 'jane@newjob.org', {}, demo)).status).toBe(403)
    expect((await call('/api/auth/email-change/confirm', { method: 'POST', body: '{"token":"x"}' }, demo)).status).toBe(403)
    expect(sent).toHaveLength(0)
  })

  it('still answers the read-only status call on a demo instance', async () => {
    const r = await call('/api/auth/email-change/status', { method: 'POST', body: '{"token":"x"}' }, { DEMO_MODE: 'true' })
    expect(r).toMatchObject({ status: 200, body: { status: 'invalid' } })
  })
})

// Email-change emails send by the account purpose (#707): the confirmation
// link, the notice to the old address, and the "this wasn't me" report all fall
// back to the second provider, count each attempt to the provider that made it,
// and are never sent from a demo instance. A new address that can't receive
// mail is told so, and an outage is told to try again.
describe('sending by purpose', () => {
  /** A Cloudflare binding that fails for the addresses `fails` names (a suppression code is permanent, any other code is an outage), and delivers the rest. It becomes the binding `sent` reads. */
  function binding(fails: (to: string) => string | null) {
    return useBinding((m) => {
      const code = fails([m.to].flat()[0])
      return code === 'E_RECIPIENT_SUPPRESSED' ? 'suppressed' : code ? 'down' : 'ok'
    })
  }
  const down = () => 'E_INTERNAL_SERVER_ERROR'
  const resendBodies = (resend: ReturnType<typeof stubResend>) => resend.calls.map(c => c.body)
  async function stats() {
    return Object.fromEntries((await getDb(env.DB).select().from(emailSendStats).all()).map(r => [r.provider, r]))
  }
  const withResend = { RESEND_API_KEY: 'test-api-key' }
  const noContext = { userAgent: null, ipCountry: null }

  beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => {}); vi.spyOn(console, 'warn').mockImplementation(() => {}) })
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

  it('sends the confirmation and the old-address notice through Resend when Cloudflare is down, counting each attempt to its own provider', async () => {
    const resend = stubResend()
    const r = await request(janeCookie, 'jane@newjob.org', {}, { EMAIL: binding(down).binding, ...withResend })
    expect(r.status).toBe(200)
    expect(sent).toHaveLength(0)
    const bodies = resendBodies(resend)
    expect(bodies.map(b => b.to[0]).sort()).toEqual(['jane@newjob.org', 'jane@oldjob.org'])
    const by = await stats()
    expect(by.cloudflare).toMatchObject({ sent: 0, failed: 2, suppressed: 0 })
    expect(by.resend).toMatchObject({ sent: 2, failed: 0 })
    // The link that went out through Resend is a working one.
    const token = bodies.find(b => b.to[0] === 'jane@newjob.org')!.text.match(LINK)![1]
    expect((await confirm(token)).status).toBe(200)
    expect((await member(jane)).email).toBe('jane@newjob.org')
  })

  it('counts a confirmation that worked first time once, to the first provider', async () => {
    const resend = stubResend()
    await request(janeCookie, 'jane@newjob.org', {}, withResend)
    expect(resend.calls).toHaveLength(0)
    expect((await stats()).cloudflare).toMatchObject({ sent: 2, failed: 0 })
    expect((await stats()).resend).toBeUndefined()
  })

  it('sends the notice to the old address through Resend when only the notice would fail on Cloudflare', async () => {
    const resend = stubResend()
    const r = await request(janeCookie, 'jane@newjob.org', {}, { EMAIL: binding(to => (to === 'jane@oldjob.org' ? 'E_INTERNAL_SERVER_ERROR' : null)).binding, ...withResend })
    expect(r.status).toBe(200)
    expect(sent.map(m => m.to[0])).toEqual(['jane@newjob.org'])
    expect(resendBodies(resend)).toHaveLength(1)
    const [notice] = resendBodies(resend)
    expect(notice.to).toEqual(['jane@oldjob.org'])
    expect(notice.text).toMatch(/\/auth\/not-me\?token=[0-9a-f]{64}/)
  })

  it('sends the commit notice to the old address through Resend when Cloudflare is down', async () => {
    await request(janeCookie, 'jane@newjob.org')
    const token = tokenSentTo('jane@newjob.org')
    useBinding()
    const resend = stubResend()
    const r = await call('/api/auth/email-change/confirm', { method: 'POST', body: JSON.stringify({ token }) }, { EMAIL: binding(down).binding, ...withResend })
    expect(r.status).toBe(200)
    expect((await member(jane)).email).toBe('jane@newjob.org')
    expect(resendBodies(resend)).toHaveLength(1)
    const [notice] = resendBodies(resend)
    expect(notice.to).toEqual(['jane@oldjob.org'])
    expect(notice.subject).toMatch(/changed/i)
  })

  it('answers "this address can\'t receive email" when the new address is suppressed, without retrying it through Resend', async () => {
    const resend = stubResend()
    const mail = binding(to => (to === 'jane@newjob.org' ? 'E_RECIPIENT_SUPPRESSED' : null))
    const r = await request(janeCookie, 'jane@newjob.org', {}, { EMAIL: mail.binding, ...withResend })
    expect(r.status).toBe(400)
    expect(r.body).toEqual({ error: "That address can't receive email. Check it for a typo, or use a different address." })
    expect(resend.calls).toHaveLength(0)
    // No pending change, no notice to the old address (nothing happened), but the request still used its allowance.
    expect(await getDb(env.DB).select().from(emailChanges).all()).toHaveLength(0)
    expect(sent).toHaveLength(0)
    expect((await eventsFor(jane)).filter(e => e.event === 'email_change_requested')).toHaveLength(1)
    // A dead address is the address's problem, not an outage.
    expect((await stats()).cloudflare).toMatchObject({ sent: 0, failed: 0, suppressed: 1 })
  })

  it('answers "try again" when both providers are down, and counts one failure on each', async () => {
    const resend = stubResend('down', { status: 500, body: 'upstream error' })
    const r = await request(janeCookie, 'jane@newjob.org', {}, { EMAIL: binding(down).binding, ...withResend })
    expect(r.status).toBe(502)
    expect(r.body).toEqual({ error: EMAIL_CHANGE_ERRORS.sendFailed })
    expect(r.body.error).toMatch(/try again/i)
    expect(resend.calls).toHaveLength(1)
    expect(await getDb(env.DB).select().from(emailChanges).all()).toHaveLength(0)
    const by = await stats()
    expect(by.cloudflare).toMatchObject({ sent: 0, failed: 1, suppressed: 0 })
    expect(by.resend).toMatchObject({ sent: 0, failed: 1, suppressed: 0 })
  })

  it('answers "try again" when a single provider is configured and down', async () => {
    const r = await request(janeCookie, 'jane@newjob.org', {}, { EMAIL: binding(down).binding, RESEND_API_KEY: '' })
    expect(r.status).toBe(502)
    expect(r.body).toEqual({ error: EMAIL_CHANGE_ERRORS.sendFailed })
    expect(await getDb(env.DB).select().from(emailChanges).all()).toHaveLength(0)
  })

  it('does not fail the request, or retry through Resend, when the old address is suppressed', async () => {
    const resend = stubResend()
    const mail = binding(to => (to === 'jane@oldjob.org' ? 'E_RECIPIENT_SUPPRESSED' : null))
    const r = await request(janeCookie, 'jane@newjob.org', {}, { EMAIL: mail.binding, ...withResend })
    expect(r.status).toBe(200)
    expect(resend.calls).toHaveLength(0)
    expect((await stats()).cloudflare).toMatchObject({ sent: 1, failed: 0, suppressed: 1 })
  })

  it('sends nothing from a demo instance, by the purpose\'s rule alone', async () => {
    const resend = stubResend()
    const mail = binding(() => null)
    await requestEmailChange(testEnv({ EMAIL: mail.binding, DEMO_MODE: 'true', ...withResend }) as never, getDb(env.DB), {
      member: { id: jane, email: 'jane@oldjob.org' }, requesterId: jane, sessionId: null, rawNewEmail: 'jane@newjob.org', ctx: noContext,
    })
    expect(mail.sent).toHaveLength(0)
    expect(resend.calls).toHaveLength(0)
    expect(await getDb(env.DB).select().from(emailSendStats).all()).toHaveLength(0)
  })

  it('sends no commit notice from a demo instance either, though the change itself goes through', async () => {
    await request(janeCookie, 'jane@newjob.org')
    const token = tokenSentTo('jane@newjob.org')
    useBinding()
    const resend = stubResend()
    const mail = binding(() => null)
    const r = await confirmEmailChange(testEnv({ EMAIL: mail.binding, DEMO_MODE: 'true', ...withResend }) as never, getDb(env.DB), token, noContext)
    expect(r.ok).toBe(true)
    expect(mail.sent).toHaveLength(0)
    expect(resend.calls).toHaveLength(0)
  })
})
