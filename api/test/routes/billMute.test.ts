import { describe, it, expect, vi, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { app } from '../../src/index'
import { eq } from 'drizzle-orm'
import { resetDb, applyMigrations, seedUser, seedSession, seedBill } from '../helpers'
import { getDb } from '../../src/db/client'
import { users } from '../../src/db/schema'

// Per-bill mute (#355). A muted bill sends that member no reply notifications,
// in the app or by email, while mentions on it still reach them. Reply emails
// carry a one-click List-Unsubscribe that mutes the bill without a session,
// through a link signed for that member and bill.
//
// Every case goes through the real HTTP routes. Emails are read at the stubbed
// Cloudflare email binding, and the executionCtx collects waitUntil promises so
// each request is awaited to completion before asserting.
describe('muting comments on a bill', () => {
  let send: ReturnType<typeof vi.fn>
  let pending: Promise<unknown>[]
  let billId: string
  const cookies = new Map<string, string>()
  const ids: Record<string, string> = {}
  // Cloudflare Email Service accepts List-Unsubscribe only with an https URI.
  const HTTPS = { APP_URL: 'https://floorvote.example.org' }

  type SentEmail = { to: string[]; subject: string; html: string; headers?: Record<string, string> }
  const sent = () => send.mock.calls.map(call => call[0] as SentEmail)
  const emailedTo = () => sent().flatMap(m => m.to).sort()
  const sentTo = (who: string) => sent().filter(m => m.to[0] === `${who}@example.com`)

  async function request(
    path: string, method: string, as: string | null, body?: unknown,
    opts: { extraEnv?: Record<string, unknown>; raw?: { body: string; contentType: string } } = {},
  ) {
    const ctx = {
      waitUntil: (p: Promise<unknown>) => { pending.push(p) },
      passThroughOnException: () => {},
    } as unknown as ExecutionContext
    const headers: Record<string, string> = { 'Content-Type': opts.raw?.contentType ?? 'application/json' }
    if (as) headers.Cookie = cookies.get(as)!
    const res = await app.request(path, {
      method,
      headers,
      body: opts.raw ? opts.raw.body : body === undefined ? undefined : JSON.stringify(body),
    }, { ...env, EMAIL_PROVIDER: 'cloudflare', EMAIL: { send }, ...HTTPS, ...opts.extraEnv }, ctx)
    await Promise.all(pending.splice(0))
    return res
  }

  async function comment(as: string, content: string, onBill = billId) {
    const res = await request(`/api/bills/${onBill}/comments`, 'POST', as, { content })
    expect(res.status).toBe(201)
    return (await res.json() as { id: string }).id
  }

  type Row = { kind: string; commentId: string }
  async function inboxFor(as: string, commentId: string) {
    const res = await request('/api/notifications', 'GET', as)
    expect(res.status).toBe(200)
    const { notifications } = await res.json() as { notifications: Row[] }
    return notifications.filter(n => n.commentId === commentId).map(n => n.kind)
  }

  async function member(name: string, role: 'member' | 'admin' | 'owner' = 'member') {
    const id = await seedUser({ name, role, email: `${name.toLowerCase()}@example.com` })
    ids[name.toLowerCase()] = id
    cookies.set(name.toLowerCase(), `session=${await seedSession(id)}`)
    return id
  }

  async function mute(as: string, onBill = billId) {
    const res = await request(`/api/bills/${onBill}/mute`, 'PUT', as)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ muted: true })
  }
  async function unmute(as: string, onBill = billId) {
    const res = await request(`/api/bills/${onBill}/mute`, 'DELETE', as)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ muted: false })
  }
  async function mutedOnPage(as: string, onBill = billId) {
    const res = await request(`/api/bills/${onBill}`, 'GET', as)
    expect(res.status).toBe(200)
    return (await res.json() as { commentsMuted: boolean }).commentsMuted
  }

  const userMention = (id: string, label: string) =>
    `<span data-type="mention" data-id="user:${id}" data-label="${label}">@${label}</span>`
  const adminsMention = '<span data-type="mention" data-id="admins:all" data-label="admins">@admins</span>'
  const everyoneMention = '<span data-type="mention" data-id="everyone:all" data-label="everyone">@everyone</span>'

  /** The one-click URL from a reply email's List-Unsubscribe header. */
  function oneClickUrl(email: SentEmail): string {
    const header = email.headers?.['List-Unsubscribe']
    expect(header, 'the reply email has a List-Unsubscribe header').toBeTypeOf('string')
    expect(header).toMatch(/^<https:\/\/[^<>]+>$/)
    return header!.slice(1, -1)
  }
  /** Path and query of a one-click URL, to send through app.request. */
  const pathOf = (url: string) => { const u = new URL(url); return u.pathname + u.search }
  const tokenOf = (url: string) => new URL(url).searchParams.get('token')!

  /** POST the way a mail client's one-click unsubscribe does (RFC 8058): no cookie, a form body. */
  const oneClick = (path: string) => request(path, 'POST', null, undefined, {
    raw: { body: 'List-Unsubscribe=One-Click', contentType: 'application/x-www-form-urlencoded' },
  })

  /** Ben's and Cara's reply emails for one new comment by Ann on `onBill`. */
  async function replyEmails(onBill = billId) {
    send.mockClear()
    await comment('ann', '<p>Another thought</p>', onBill)
    return { ben: sentTo('ben')[0], cara: sentTo('cara')[0] }
  }

  beforeEach(async () => {
    await resetDb(); await applyMigrations()
    send = vi.fn(async () => ({ messageId: 'm-1' }))
    pending = []
    cookies.clear()
    billId = await seedBill({ billNumber: 'HB 1' })
    await member('Ann', 'admin')
    await member('Ben')
    await member('Cara')
  })

  it('lets a member mute and unmute a bill from its page, before commenting on it', async () => {
    expect(await mutedOnPage('ben')).toBe(false)

    await mute('ben')
    expect(await mutedOnPage('ben')).toBe(true)
    // Muting is per member.
    expect(await mutedOnPage('cara')).toBe(false)
    // Muting twice is fine.
    await mute('ben')

    await unmute('ben')
    expect(await mutedOnPage('ben')).toBe(false)
    // So is unmuting a bill that isn't muted.
    await unmute('ben')
  })

  it('needs a session to mute from the bill page, and a bill that exists', async () => {
    await mute('ben')
    expect((await request(`/api/bills/${billId}/mute`, 'PUT', null)).status).toBe(401)
    expect((await request(`/api/bills/${billId}/mute`, 'DELETE', null)).status).toBe(401)
    expect((await request('/api/bills/no-such-bill/mute', 'PUT', 'ben')).status).toBe(404)
  })

  it('sends a muted member no reply notification, in the app or by email', async () => {
    await comment('ben', '<p>First</p>')
    await comment('cara', '<p>Second</p>')
    await mute('ben')
    send.mockClear()

    const commentId = await comment('ann', '<p>Third</p>')

    expect(await inboxFor('ben', commentId)).toEqual([])
    expect(await inboxFor('cara', commentId)).toEqual(['reply'])
    expect(emailedTo()).toEqual(['cara@example.com'])
  })

  it('keeps a member muted when they mute first and comment later', async () => {
    await mute('ben')
    await comment('ben', '<p>One comment and done</p>')
    send.mockClear()

    const commentId = await comment('ann', '<p>Reply</p>')

    expect(await inboxFor('ben', commentId)).toEqual([])
    expect(send).not.toHaveBeenCalled()
  })

  it('mutes only the one bill', async () => {
    const other = await seedBill({ billNumber: 'HB 2' })
    await comment('ben', '<p>Here</p>')
    await comment('ben', '<p>And there</p>', other)
    await mute('ben')
    send.mockClear()

    const commentId = await comment('ann', '<p>On the other bill</p>', other)

    expect(await inboxFor('ben', commentId)).toEqual(['reply'])
    expect(emailedTo()).toEqual(['ben@example.com'])
  })

  it('resumes reply notifications after unmuting', async () => {
    await comment('ben', '<p>First</p>')
    await mute('ben')
    await unmute('ben')
    send.mockClear()

    const commentId = await comment('ann', '<p>Back again</p>')

    expect(await inboxFor('ben', commentId)).toEqual(['reply'])
    expect(emailedTo()).toEqual(['ben@example.com'])
  })

  it('still delivers a mention of the member on a muted bill, in the app and by email', async () => {
    await comment('ben', '<p>First</p>')
    await mute('ben')
    send.mockClear()

    const commentId = await comment('cara', `<p>${userMention(ids.ben, 'Ben')} one question</p>`)

    expect(await inboxFor('ben', commentId)).toEqual(['mention'])
    expect(sentTo('ben')).toHaveLength(1)
    expect(sentTo('ben')[0].subject).toMatch(/mentioned/)
  })

  it('still delivers @admins and @everyone on a muted bill', async () => {
    const dee = await member('Dee', 'admin')
    await comment('dee', '<p>First</p>')
    await mute('dee')
    await mute('ben')
    send.mockClear()

    const toAdmins = await comment('cara', `<p>${adminsMention} please look</p>`)
    expect(await inboxFor('dee', toAdmins)).toEqual(['mention'])
    expect(emailedTo()).toContain('dee@example.com')

    send.mockClear()
    const toEveryone = await comment('ann', `<p>${everyoneMention} heads up</p>`)
    expect(await inboxFor('ben', toEveryone)).toEqual(['mention'])
    expect(await inboxFor('dee', toEveryone)).toEqual(['mention'])
    expect(emailedTo()).toEqual(expect.arrayContaining(['ben@example.com', 'dee@example.com']))
    expect(await mutedOnPage('dee')).toBe(true)
    expect(dee).toBeTruthy()
  })

  it('gives reply emails a one-click List-Unsubscribe and footer links to mute the bill and turn off reply emails', async () => {
    await comment('ben', '<p>First</p>')
    const { ben } = await replyEmails()

    expect(ben.headers!['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click')
    const url = oneClickUrl(ben)
    expect(url.startsWith('https://floorvote.example.org/')).toBe(true)
    expect(ben.html).toContain('Mute this bill')
    expect(ben.html).toContain('Turn off reply emails')
    expect(ben.html).toContain('/profile#setting-email-replies')
    // The footer link opens a page that asks before muting, so a mail scanner
    // that follows links can't mute anything.
    expect(ben.html).toContain(`https://floorvote.example.org/mute-bill?token=${encodeURIComponent(tokenOf(url))}`)
  })

  it('mutes the bill when the one-click link is posted with no session', async () => {
    await comment('ben', '<p>First</p>')
    await comment('cara', '<p>Second</p>')
    const { ben } = await replyEmails()

    const res = await oneClick(pathOf(oneClickUrl(ben)))
    expect(res.status).toBe(200)

    expect(await mutedOnPage('ben')).toBe(true)
    expect(await mutedOnPage('cara')).toBe(false)
    const { ben: after, cara } = await replyEmails()
    expect(after).toBeUndefined()
    expect(cara).toBeDefined()
  })

  it('mutes from the confirmation page, which posts the token in the body, and names the bill', async () => {
    await comment('ben', '<p>First</p>')
    const { ben } = await replyEmails()

    const res = await request('/api/mute-link', 'POST', null, { token: tokenOf(oneClickUrl(ben)) })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ billNumber: 'HB 1' })
    expect(await mutedOnPage('ben')).toBe(true)
  })

  it('refuses a tampered link and mutes nothing', async () => {
    await comment('ben', '<p>First</p>')
    const { ben } = await replyEmails()
    const token = tokenOf(oneClickUrl(ben))
    const last = token.slice(-1)
    const tampered = token.slice(0, -1) + (last === 'A' ? 'B' : 'A')

    const res = await request(`/api/mute-link?token=${encodeURIComponent(tampered)}`, 'POST', null)
    expect(res.status).toBe(404)
    expect(await mutedOnPage('ben')).toBe(false)
  })

  it('refuses one member\'s signature on another member\'s link', async () => {
    await comment('ben', '<p>First</p>')
    await comment('cara', '<p>Second</p>')
    const { ben, cara } = await replyEmails()
    const [benPayload] = tokenOf(oneClickUrl(ben)).split('.')
    const [, caraSignature] = tokenOf(oneClickUrl(cara)).split('.')

    const res = await request('/api/mute-link', 'POST', null, { token: `${benPayload}.${caraSignature}` })
    expect(res.status).toBe(404)
    expect(await mutedOnPage('ben')).toBe(false)
    expect(await mutedOnPage('cara')).toBe(false)
  })

  it('scopes a link to its bill', async () => {
    const other = await seedBill({ billNumber: 'HB 2' })
    await comment('ben', '<p>First</p>')
    await comment('ben', '<p>First there</p>', other)
    const { ben } = await replyEmails()

    expect((await oneClick(pathOf(oneClickUrl(ben)))).status).toBe(200)

    expect(await mutedOnPage('ben')).toBe(true)
    expect(await mutedOnPage('ben', other)).toBe(false)
  })

  it('answers a forged link and a garbled one the same way', async () => {
    const forged = await request('/api/mute-link', 'POST', null, { token: `${btoa(JSON.stringify([ids.ben, billId]))}.${'A'.repeat(43)}` })
    const garbled = await request('/api/mute-link', 'POST', null, { token: 'not-a-token' })
    const missing = await request('/api/mute-link', 'POST', null, {})

    expect(forged.status).toBe(404)
    expect(garbled.status).toBe(404)
    expect(missing.status).toBe(404)
    const bodies = await Promise.all([forged.text(), garbled.text(), missing.text()])
    expect(bodies[1]).toBe(bodies[0])
    expect(bodies[2]).toBe(bodies[0])
    // A JSON error from the mute-link route, not a 404 for a route that isn't there.
    expect(forged.headers.get('content-type') ?? '').toContain('application/json')
    expect(Object.keys(JSON.parse(bodies[0]))).toEqual(['error'])
  })

  it('refuses the link of a member who has since been deactivated', async () => {
    await comment('ben', '<p>First</p>')
    const { ben } = await replyEmails()
    await getDb(env.DB).update(users).set({ deactivatedAt: '2026-01-01 00:00:00' }).where(eq(users.id, ids.ben))

    expect((await oneClick(pathOf(oneClickUrl(ben)))).status).toBe(404)
  })

  it('leaves List-Unsubscribe off when the instance URL is not https, keeping the footer link', async () => {
    await comment('ben', '<p>First</p>')
    send.mockClear()
    await request(`/api/bills/${billId}/comments`, 'POST', 'ann', { content: '<p>Local</p>' }, { extraEnv: { APP_URL: 'http://localhost:5173' } })

    const [ben] = sentTo('ben')
    expect(ben.headers?.['List-Unsubscribe']).toBeUndefined()
    expect(ben.headers?.['List-Unsubscribe-Post']).toBeUndefined()
    expect(ben.html).toContain('http://localhost:5173/mute-bill?token=')
  })

  it('puts no unsubscribe link on mention emails', async () => {
    await comment('cara', '<p>First</p>')
    send.mockClear()
    await comment('ann', `<p>${userMention(ids.ben, 'Ben')} see this</p>`)

    // The same comment's reply email to Cara carries one, and Ben's mention does not.
    const [cara] = sentTo('cara')
    expect(cara.headers?.['List-Unsubscribe']).toBeDefined()
    const [ben] = sentTo('ben')
    expect(ben.subject).toMatch(/mentioned/)
    expect(ben.headers?.['List-Unsubscribe']).toBeUndefined()
    expect(ben.headers?.['List-Unsubscribe-Post']).toBeUndefined()
    expect(ben.html).not.toContain('Mute this bill')
    expect(ben.html).not.toContain('/mute-bill')
  })
})
