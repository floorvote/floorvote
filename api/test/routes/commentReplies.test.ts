import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { env } from 'cloudflare:test'
import { app } from '../../src/index'
import {
  resetDb, applyMigrations, seedUser, seedSession, seedBill, seedComment, seedRole, seedUserRole, stubFetch
} from '../helpers'
import { getDb } from '../../src/db/client'
import { associationConfig, comments, memberVotes, notes, notifications, emailSendStats } from '../../src/db/schema'

// Central's superadmin allowlist is fetched in the background on a first
// authenticated request; answer it so the network guard stays quiet.
beforeEach(() => { stubFetch() })

// A new comment notifies the bill's other commenters (its participants). Every
// case goes through the real HTTP routes. Replies are read from GET
// /notifications and emails are read at the Cloudflare email binding, which is
// stubbed. Emails go out from waitUntil, so the executionCtx below collects
// those promises and each request is awaited to completion before asserting.
describe('replying to a bill notifies its other commenters', () => {
  let send: ReturnType<typeof vi.fn>
  let pending: Promise<unknown>[]
  let billId: string
  const cookies = new Map<string, string>()
  const ids: Record<string, string> = {}

  type SentEmail = { to: string[]; subject: string; html: string; headers?: Record<string, string> }
  const sent = () => send.mock.calls.map(call => call[0] as SentEmail)
  const emailedTo = () => sent().flatMap(m => m.to).sort()

  async function request(
    path: string, method: string, as: string, body?: unknown, extraEnv: Record<string, unknown> = {},
  ) {
    const ctx = {
      waitUntil: (p: Promise<unknown>) => { pending.push(p) },
      passThroughOnException: () => {},
    } as unknown as ExecutionContext
    const res = await app.request(path, {
      method,
      headers: { Cookie: cookies.get(as)!, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }, { ...env, EMAIL_PROVIDER: 'cloudflare', EMAIL: { send }, ...extraEnv }, ctx)
    await Promise.all(pending.splice(0))
    return res
  }

  async function comment(as: string, content: string, onBill = billId, extraEnv: Record<string, unknown> = {}) {
    const res = await request(`/api/bills/${onBill}/comments`, 'POST', as, { content }, extraEnv)
    expect(res.status).toBe(201)
    return (await res.json() as { id: string }).id
  }

  type Row = { id: string; kind: string; commentId: string; billId: string; authorId: string; isUnread: boolean }
  async function inbox(as: string) {
    const res = await request('/api/notifications', 'GET', as)
    expect(res.status).toBe(200)
    return await res.json() as { unreadCount: number; notifications: Row[] }
  }
  const kinds = async (as: string) => (await inbox(as)).notifications.map(n => n.kind)

  async function member(name: string, opts: Parameters<typeof seedUser>[0] & { session?: boolean } = {}) {
    const id = await seedUser({ name, email: `${name.toLowerCase()}@example.com`, ...opts })
    ids[name.toLowerCase()] = id
    if (opts.session !== false) cookies.set(name.toLowerCase(), `session=${await seedSession(id)}`)
    return id
  }

  const mention = (id: string, label: string) =>
    `<span data-type="mention" data-id="user:${id}" data-label="${label}">@${label}</span>`

  beforeEach(async () => {
    await resetDb(); await applyMigrations()
    send = vi.fn(async () => ({ messageId: 'm-1' }))
    pending = []
    cookies.clear()
    billId = await seedBill({ billNumber: 'HB 1' })
    await member('Ann')
    await member('Ben')
    await member('Cara')
  })

  it('creates a reply notification for each other participant and none for the author', async () => {
    await comment('ben', '<p>First</p>')
    await comment('cara', '<p>Second</p>')
    const commentId = await comment('ann', '<p>Third</p>')

    for (const who of ['ben', 'cara']) {
      const { notifications } = await inbox(who)
      const mine = notifications.filter(n => n.commentId === commentId)
      expect(mine).toHaveLength(1)
      expect(mine[0]).toMatchObject({ kind: 'reply', billId, authorId: ids.ann, isUnread: true })
    }
    expect((await inbox('ann')).notifications.filter(n => n.commentId === commentId)).toHaveLength(0)
  })

  it('does not notify the author of a comment on a bill nobody else has commented on', async () => {
    await comment('ann', '<p>Alone</p>')
    expect(await kinds('ann')).toEqual([])
    expect(send).not.toHaveBeenCalled()
  })

  it('gives a participant the comment mentions the mention only, and one email', async () => {
    await comment('ben', '<p>First</p>')
    await comment('cara', '<p>Second</p>')
    send.mockClear()
    const commentId = await comment('ann', `<p>${mention(ids.ben, 'Ben')} thoughts?</p>`)

    const ben = (await inbox('ben')).notifications.filter(n => n.commentId === commentId)
    expect(ben.map(n => n.kind)).toEqual(['mention'])
    const cara = (await inbox('cara')).notifications.filter(n => n.commentId === commentId)
    expect(cara.map(n => n.kind)).toEqual(['reply'])

    const toBen = sent().filter(m => m.to[0] === 'ben@example.com')
    expect(toBen).toHaveLength(1)
    expect(toBen[0].subject).toMatch(/mentioned/)
    expect(emailedTo()).toEqual(['ben@example.com', 'cara@example.com'])
  })

  it('treats a participant reached through a role mention as mentioned', async () => {
    const team = await seedRole('Team')
    await seedUserRole(ids.ben, team)
    await comment('ben', '<p>First</p>')
    const commentId = await comment('ann',
      `<p><span data-type="mention" data-id="role:${team}" data-label="Team">@Team</span></p>`)
    expect((await inbox('ben')).notifications.filter(n => n.commentId === commentId).map(n => n.kind)).toEqual(['mention'])
  })

  it('does not make a member a participant by voting, writing a note, or being mentioned', async () => {
    await member('Dee'); await member('Eli'); await member('Fay')
    const db = getDb(env.DB)
    await db.insert(memberVotes).values({ id: crypto.randomUUID(), userId: ids.dee, billId, position: 'support' })
    await db.insert(notes).values({ id: crypto.randomUUID(), userId: ids.eli, billId, content: 'private' })
    await comment('ann', `<p>${mention(ids.fay, 'Fay')} see this</p>`)
    send.mockClear()

    await comment('ben', '<p>Another comment</p>')

    expect(await kinds('dee')).toEqual([])
    expect(await kinds('eli')).toEqual([])
    // Fay was mentioned once, on the earlier comment, and nothing since.
    expect(await kinds('fay')).toEqual(['mention'])
    expect(emailedTo()).toEqual(['ann@example.com'])
  })

  it('does not count a member whose only comment was deleted', async () => {
    const gone = await comment('cara', '<p>Oops</p>')
    await request(`/api/comments/${gone}`, 'DELETE', 'cara')
    await comment('ann', '<p>Hello</p>')
    expect(await kinds('cara')).toEqual([])
  })

  it('does not notify the participants of a different bill', async () => {
    const other = await seedBill({ billNumber: 'HB 2' })
    await comment('cara', '<p>On another bill</p>', other)
    await comment('ben', '<p>Here</p>')
    send.mockClear()
    await comment('ann', '<p>Hi</p>')
    expect(await kinds('cara')).toEqual([])
    expect(emailedTo()).toEqual(['ben@example.com'])
  })

  it('skips deactivated members and members without a login session', async () => {
    await member('Gus', { deactivatedAt: '2026-01-01 00:00:00' })
    await member('Hal', { session: false })
    await seedComment(billId, ids.gus)
    await seedComment(billId, ids.hal)
    await comment('ben', '<p>Hi</p>')
    send.mockClear()

    await comment('ann', '<p>Hello</p>')

    expect(emailedTo()).toEqual(['ben@example.com'])
    // Their notifications aren't written either.
    const all = await getDb(env.DB).select().from(notifications).all()
    const recipients = all.filter(n => n.kind === 'reply').map(n => n.recipientId)
    expect(recipients).not.toContain(ids.gus)
    expect(recipients).not.toContain(ids.hal)
  })

  it('does not notify anyone when a comment is edited', async () => {
    await comment('ben', '<p>First</p>')
    const commentId = await comment('ann', '<p>Second</p>')
    send.mockClear()
    const before = await inbox('ben')

    const res = await request(`/api/comments/${commentId}`, 'PATCH', 'ann', { content: '<p>Second, fixed a typo</p>' })
    expect(res.status).toBe(200)

    expect(send).not.toHaveBeenCalled()
    const after = await inbox('ben')
    expect(after.notifications.map(n => n.id).sort()).toEqual(before.notifications.map(n => n.id).sort())
  })

  it('emails each participant once with threading headers keyed to the bill', async () => {
    await comment('ben', '<p>First</p>')
    await comment('cara', '<p>Second</p>')
    send.mockClear()
    await comment('ann', '<p>Third</p>')
    await comment('ann', '<p>Fourth</p>')

    const toBen = sent().filter(m => m.to[0] === 'ben@example.com')
    expect(toBen).toHaveLength(2)
    expect(emailedTo().filter(e => e === 'cara@example.com')).toHaveLength(2)
    const [first, second] = toBen
    // One conversation per bill: the same subject and one shared bill-keyed
    // reference on every email.
    expect(first.subject).toBe(second.subject)
    expect(first.subject).toContain('HB 1')
    expect(first.headers!['In-Reply-To']).toBe(second.headers!['In-Reply-To'])
    expect(first.headers!['References']).toBe(first.headers!['In-Reply-To'])
    expect(first.headers!['In-Reply-To']).toContain(billId)
    expect(first.headers!['In-Reply-To']).toMatch(/^<[^<>\s@]+@[^<>\s@]+>$/)
    expect(first.html).toContain('Third')
    // Cloudflare Email Service rejects the whole send when a header is
    // platform-controlled (Message-ID, for one), so only these may be set.
    for (const m of sent()) {
      for (const name of Object.keys(m.headers ?? {})) {
        expect(name).toMatch(/^(In-Reply-To|References|List-[A-Za-z-]+|X-[A-Za-z-]+)$/)
      }
    }
    // This instance URL is http, where Cloudflare Email Service refuses a
    // List-Unsubscribe. billMute.test.ts covers the https one-click mute.
    expect(first.headers!['List-Unsubscribe']).toBeUndefined()
  })

  it('links the reply email to the bill by the session slug central stored', async () => {
    const filed = await seedBill({ billNumber: 'HB 7', state: 'RI', session: '2026 Regular Session', sessionSlug: '2026-2' })
    await comment('ben', '<p>First</p>', filed)
    send.mockClear()
    await comment('ann', '<p>Second</p>', filed)

    const [toBen] = sent().filter(m => m.to[0] === 'ben@example.com')
    expect(toBen.html).toContain('/RI/2026-2/HB 7')
    expect(toBen.html).not.toContain('/RI/2026/HB 7')
  })

  it('links reply emails to the member\'s Profile setting', async () => {
    await comment('ben', '<p>First</p>')
    send.mockClear()
    await comment('ann', '<p>Second</p>')
    expect(sent()[0].html).toContain('/profile#setting-email-replies')
  })

  // "Replies on bills you've commented on" (users.emailRepliesEnabled) governs
  // the whole reply fan-out, in the app and by email. Mentions are separate.
  it('sends a member who turned the setting off neither a reply notification nor a reply email', async () => {
    await member('Ivy', { emailRepliesEnabled: false })
    await comment('ivy', '<p>First</p>')
    await comment('ben', '<p>Second</p>')
    send.mockClear()

    const commentId = await comment('ann', '<p>Third</p>')

    expect(emailedTo()).toEqual(['ben@example.com'])
    expect((await inbox('ivy')).notifications.filter(n => n.commentId === commentId)).toEqual([])
    expect((await inbox('ivy')).unreadCount).toBe(0)
    expect((await inbox('ben')).notifications.filter(n => n.commentId === commentId).map(n => n.kind)).toEqual(['reply'])
  })

  it('still notifies a member who turned the setting off of a mention, in the app and by email', async () => {
    await member('Ivy', { emailRepliesEnabled: false })
    await comment('ivy', '<p>First</p>')
    send.mockClear()

    const commentId = await comment('ann', `<p>${mention(ids.ivy, 'Ivy')} thoughts?</p>`)

    expect((await inbox('ivy')).notifications.filter(n => n.commentId === commentId).map(n => n.kind)).toEqual(['mention'])
    expect(sent().map(m => m.to[0])).toEqual(['ivy@example.com'])
    expect(sent()[0].subject).toMatch(/mentioned/)
  })

  it('still notifies a member who turned the setting off of a role mention', async () => {
    const team = await seedRole('Team')
    await member('Ivy', { emailRepliesEnabled: false })
    await seedUserRole(ids.ivy, team)
    await comment('ivy', '<p>First</p>')

    const commentId = await comment('ann',
      `<p><span data-type="mention" data-id="role:${team}" data-label="Team">@Team</span></p>`)

    expect((await inbox('ivy')).notifications.filter(n => n.commentId === commentId).map(n => n.kind)).toEqual(['mention'])
  })

  it('keeps gating the mention email of a member who turned the setting off on the instance switch', async () => {
    await member('Ivy', { emailRepliesEnabled: false })
    await comment('ivy', '<p>First</p>')
    await getDb(env.DB).insert(associationConfig).values({ key: 'mention_emails_enabled', value: 'false' })
    send.mockClear()

    const commentId = await comment('ann', `<p>${mention(ids.ivy, 'Ivy')} thoughts?</p>`)

    expect((await inbox('ivy')).notifications.filter(n => n.commentId === commentId).map(n => n.kind)).toEqual(['mention'])
    expect(send).not.toHaveBeenCalled()
  })

  it('sends nothing to a member who turned the setting off and also muted the bill', async () => {
    await member('Ivy', { emailRepliesEnabled: false })
    await comment('ivy', '<p>First</p>')
    expect((await request(`/api/bills/${billId}/mute`, 'PUT', 'ivy')).status).toBe(200)
    send.mockClear()

    const commentId = await comment('ann', '<p>Second</p>')

    expect((await inbox('ivy')).notifications.filter(n => n.commentId === commentId)).toEqual([])
    expect(send).not.toHaveBeenCalled()
  })

  it('lets a member switch replies off and on from their profile', async () => {
    await comment('ben', '<p>First</p>')
    expect((await request('/api/users/me', 'PATCH', 'ben', { emailRepliesEnabled: false })).status).toBe(200)
    expect(((await (await request('/api/auth/me', 'GET', 'ben')).json()) as { emailRepliesEnabled: boolean }).emailRepliesEnabled).toBe(false)
    send.mockClear()
    const whileOff = await comment('ann', '<p>Second</p>')
    expect(send).not.toHaveBeenCalled()
    expect((await inbox('ben')).notifications.filter(n => n.commentId === whileOff)).toEqual([])

    await request('/api/users/me', 'PATCH', 'ben', { emailRepliesEnabled: true })
    const whileOn = await comment('ann', '<p>Third</p>')
    expect(emailedTo()).toEqual(['ben@example.com'])
    expect((await inbox('ben')).notifications.filter(n => n.commentId === whileOn).map(n => n.kind)).toEqual(['reply'])
  })

  it('stops reply emails but not in-app replies when the instance turned conversation emails off', async () => {
    await comment('ben', '<p>First</p>')
    await getDb(env.DB).insert(associationConfig).values({ key: 'mention_emails_enabled', value: 'false' })
    send.mockClear()

    const commentId = await comment('ann', '<p>Second</p>')

    expect(send).not.toHaveBeenCalled()
    expect((await inbox('ben')).notifications.filter(n => n.commentId === commentId).map(n => n.kind)).toEqual(['reply'])
  })

  it('sends no email on a demo instance but still notifies in the app', async () => {
    await comment('ben', '<p>First</p>')
    send.mockClear()

    const commentId = await comment('ann', '<p>Second</p>', billId, { DEMO_MODE: 'true' })

    expect(send).not.toHaveBeenCalled()
    expect((await inbox('ben')).notifications.filter(n => n.commentId === commentId).map(n => n.kind)).toEqual(['reply'])
  })

  it('counts replies toward the unread total and clears them when the bill is opened', async () => {
    await comment('ben', '<p>First</p>')
    await comment('ann', '<p>Second</p>')
    await comment('cara', '<p>Third</p>')

    expect((await inbox('ben')).unreadCount).toBe(2)
    await request(`/api/notifications/mark-read-by-bill/${billId}`, 'POST', 'ben')
    expect((await inbox('ben')).unreadCount).toBe(0)
  })

  it('hides the reply when its comment is deleted', async () => {
    await comment('ben', '<p>First</p>')
    const commentId = await comment('ann', '<p>Second</p>')
    await request(`/api/comments/${commentId}`, 'DELETE', 'ann')
    expect((await inbox('ben')).notifications).toHaveLength(0)
    expect(await getDb(env.DB).select().from(comments).where(eq(comments.id, commentId)).all()).toHaveLength(1)
  })

  it('notifies and emails more than 100 participants', async () => {
    const emails: string[] = []
    for (let i = 0; i < 105; i++) {
      const id = await seedUser({ name: `P ${i}`, email: `p${i}@example.com` })
      await seedSession(id)
      await seedComment(billId, id)
      emails.push(`p${i}@example.com`)
    }
    const commentId = await comment('ann', '<p>Hello everyone</p>')

    expect(emailedTo()).toEqual([...emails].sort())
    const rows = await getDb(env.DB).select().from(notifications).where(eq(notifications.commentId, commentId)).all()
    expect(rows).toHaveLength(105)
  }, 60_000)

  // Mention and reply emails send by the notification purpose (#707): each falls
  // back to the second provider, counts to the provider that sent it, keeps a
  // reply's thread and mute headers, and never goes out from a demo instance.
  describe('sending by purpose', () => {
    const cfError = (code: string) => Object.assign(new Error(code.toLowerCase()), { code })
    /** A Cloudflare binding that throws the code `fails` names for a recipient, and delivers the rest. */
    function binding(fails: (to: string) => string | null) {
      return {
        send: vi.fn(async (m: SentEmail) => {
          const code = fails(m.to[0])
          if (code) throw cfError(code)
          return { messageId: 'cf-1' }
        }),
      }
    }
    const down = () => 'E_INTERNAL_SERVER_ERROR'
    const HTTPS = { APP_URL: 'https://floorvote.example.org' }
    const withResend = { RESEND_API_KEY: 'test-api-key' }
    type ResendBody = { to: string[]; subject: string; headers?: Record<string, string> }
    function resend(handler: () => Response = () => new Response(JSON.stringify({ id: 'rs-1' }), { status: 200 })) {
      const spy = stubFetch(handler)
      const calls = () => spy.mock.calls
        .filter(c => String(c[0]) === 'https://api.resend.com/emails')
        .map(c => JSON.parse(String((c[1] as RequestInit).body)) as ResendBody)
      return { spy, calls }
    }
    async function stats() {
      return Object.fromEntries((await getDb(env.DB).select().from(emailSendStats).all()).map(r => [r.provider, r]))
    }
    // Setup comments send emails of their own, so count from the comment under test.
    const resetStats = () => env.DB.prepare('DELETE FROM email_send_stats').run()

    beforeEach(() => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      vi.spyOn(console, 'warn').mockImplementation(() => {})
    })
    afterEach(() => { vi.restoreAllMocks() })

    it('sends a reply through Resend when Cloudflare is down, keeping its thread and one-click mute headers', async () => {
      await comment('ben', '<p>First</p>')
      await resetStats()
      const r = resend()
      const EMAIL = binding(down)
      await comment('ann', '<p>Second</p>', billId, { EMAIL, ...withResend, ...HTTPS })

      expect(r.calls()).toHaveLength(1)
      const [mail] = r.calls()
      expect(mail.to).toEqual(['ben@example.com'])
      expect(mail.subject).toBe('[HB 1] New comment')
      expect(mail.headers).toMatchObject({
        'In-Reply-To': expect.stringContaining(billId),
        References: expect.stringContaining(billId),
        'List-Unsubscribe': expect.stringContaining('/api/mute-link?token='),
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      })
      // The same headers went to Cloudflare first.
      expect(EMAIL.send).toHaveBeenCalledOnce()
      expect(EMAIL.send.mock.calls[0][0].headers).toEqual(mail.headers)
      const by = await stats()
      expect(by.cloudflare).toMatchObject({ sent: 0, failed: 1, suppressed: 0 })
      expect(by.resend).toMatchObject({ sent: 1, failed: 0 })
    })

    it('sends a mention through Resend when Cloudflare is down, counting each attempt to its own provider', async () => {
      const r = resend()
      await comment('ann', `<p>${mention(ids.ben, 'Ben')} thoughts?</p>`, billId, { EMAIL: binding(down), ...withResend })
      expect(r.calls()).toHaveLength(1)
      const [mail] = r.calls()
      expect(mail.to).toEqual(['ben@example.com'])
      expect(mail.subject).toMatch(/mentioned/)
      const by = await stats()
      expect(by.cloudflare).toMatchObject({ sent: 0, failed: 1 })
      expect(by.resend).toMatchObject({ sent: 1, failed: 0 })
    })

    it('counts a reply that worked first time once, to the first provider, and never touches Resend', async () => {
      await comment('ben', '<p>First</p>')
      await resetStats()
      const r = resend()
      await comment('ann', '<p>Second</p>', billId, { ...withResend })
      expect(r.calls()).toHaveLength(0)
      expect((await stats()).cloudflare).toMatchObject({ sent: 1, failed: 0 })
      expect((await stats()).resend).toBeUndefined()
    })

    it('ends a batch of replies per recipient: one delivered, one rescued, one undeliverable, all still notified in the app', async () => {
      await member('Dan')
      await comment('ben', '<p>First</p>')
      await comment('cara', '<p>Second</p>')
      await comment('dan', '<p>Third</p>')
      await resetStats()
      const r = resend()
      const EMAIL = binding(to => (to === 'cara@example.com' ? 'E_INTERNAL_SERVER_ERROR' : to === 'dan@example.com' ? 'E_RECIPIENT_SUPPRESSED' : null))
      const commentId = await comment('ann', '<p>Fourth</p>', billId, { EMAIL, ...withResend })

      // Dan's address is dead, so Resend is never asked. Cara's goes out through it.
      expect(r.calls().map(m => m.to[0])).toEqual(['cara@example.com'])
      expect(EMAIL.send.mock.calls.map(c => c[0].to[0]).sort()).toEqual(['ben@example.com', 'cara@example.com', 'dan@example.com'])
      const by = await stats()
      expect(by.cloudflare).toMatchObject({ sent: 1, failed: 1, suppressed: 1 })
      expect(by.resend).toMatchObject({ sent: 1, failed: 0 })
      for (const who of ['ben', 'cara', 'dan']) {
        expect((await inbox(who)).notifications.filter(n => n.commentId === commentId).map(n => n.kind)).toEqual(['reply'])
      }
    })

    it('ends a batch of mentions per recipient: one delivered, one rescued, one undeliverable', async () => {
      await member('Dan')
      const team = await seedRole('Team')
      for (const who of ['ben', 'cara', 'dan']) await seedUserRole(ids[who], team)
      await resetStats()
      const r = resend()
      const EMAIL = binding(to => (to === 'cara@example.com' ? 'E_INTERNAL_SERVER_ERROR' : to === 'dan@example.com' ? 'E_RECIPIENT_SUPPRESSED' : null))
      const commentId = await comment('ann',
        `<p><span data-type="mention" data-id="role:${team}" data-label="Team">@Team</span></p>`, billId, { EMAIL, ...withResend })

      expect(r.calls().map(m => m.to[0])).toEqual(['cara@example.com'])
      expect(EMAIL.send.mock.calls.map(c => c[0].to[0]).sort()).toEqual(['ben@example.com', 'cara@example.com', 'dan@example.com'])
      const by = await stats()
      expect(by.cloudflare).toMatchObject({ sent: 1, failed: 1, suppressed: 1 })
      expect(by.resend).toMatchObject({ sent: 1, failed: 0 })
      for (const who of ['ben', 'cara', 'dan']) {
        expect((await inbox(who)).notifications.filter(n => n.commentId === commentId).map(n => n.kind)).toEqual(['mention'])
      }
    })

    it('keeps the comment and the in-app reply when both providers are down, counting one failure on each', async () => {
      await comment('ben', '<p>First</p>')
      await resetStats()
      const r = resend(() => new Response('upstream error', { status: 500 }))
      const commentId = await comment('ann', '<p>Second</p>', billId, { EMAIL: binding(down), ...withResend })
      expect(r.calls()).toHaveLength(1)
      expect((await inbox('ben')).notifications.filter(n => n.commentId === commentId).map(n => n.kind)).toEqual(['reply'])
      const by = await stats()
      expect(by.cloudflare).toMatchObject({ sent: 0, failed: 1 })
      expect(by.resend).toMatchObject({ sent: 0, failed: 1 })
    })

    it('sends neither a reply nor a mention from a demo instance, and counts nothing', async () => {
      await comment('ben', '<p>First</p>')
      await comment('cara', '<p>Second</p>')
      await resetStats()
      const r = resend()
      const EMAIL = binding(() => null)
      const commentId = await comment('ann', `<p>${mention(ids.ben, 'Ben')}</p>`, billId, { EMAIL, DEMO_MODE: 'true', ...withResend })
      expect(EMAIL.send).not.toHaveBeenCalled()
      expect(r.calls()).toHaveLength(0)
      expect(await getDb(env.DB).select().from(emailSendStats).all()).toHaveLength(0)
      expect((await inbox('ben')).notifications.filter(n => n.commentId === commentId).map(n => n.kind)).toEqual(['mention'])
      expect((await inbox('cara')).notifications.filter(n => n.commentId === commentId).map(n => n.kind)).toEqual(['reply'])
    })
  })
})
