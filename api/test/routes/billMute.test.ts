import { describe, it, expect, vi, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { app } from '../../src/index'
import { eq } from 'drizzle-orm'
import { resetDb, applyMigrations, seedUser, seedSession, seedBill, seedRole, seedUserRole } from '../helpers'
import { getDb } from '../../src/db/client'
import { bills, users } from '../../src/db/schema'

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

  it('still delivers a role mention to a member of the role on a muted bill', async () => {
    const team = await seedRole('Team')
    await seedUserRole(ids.ben, team)
    await comment('ben', '<p>First</p>')
    await mute('ben')
    send.mockClear()

    const commentId = await comment('cara', `<p><span data-type="mention" data-id="role:${team}" data-label="Team">@Team</span> thoughts?</p>`)

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
    expect(ben.html).toContain('Turn off reply notifications')
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
    const [payload, signature] = token.split('.')
    // Flip one bit of the signature's first character. Its six bits all land in
    // the first HMAC byte, so the decoded signature differs, not just padding.
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
    const flipped = alphabet[alphabet.indexOf(signature[0]) ^ 1]
    const tampered = `${payload}.${flipped}${signature.slice(1)}`
    const decode = (s: string) => atob(s.replace(/-/g, '+').replace(/_/g, '/'))
    expect(decode(tampered.split('.')[1]).charCodeAt(0)).not.toBe(decode(signature).charCodeAt(0))

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
    // Send a reply email first, so the instance has its signing key and the
    // forged token is checked against it rather than refused for want of a key.
    await comment('ben', '<p>First</p>')
    const { ben } = await replyEmails()
    expect(oneClickUrl(ben)).toBeTruthy()

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

  it('mutes nothing when the one-click URL is fetched with GET or HEAD', async () => {
    await comment('ben', '<p>First</p>')
    const { ben } = await replyEmails()
    const path = pathOf(oneClickUrl(ben))

    // RFC 8058: only the POST mutes. Mail scanners and previews follow links with GET.
    await request(path, 'GET', null)
    await request(path, 'HEAD', null)

    expect(await mutedOnPage('ben')).toBe(false)
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

  it('carries a mute on a draft over to the filed bill it is linked to', async () => {
    const draft = await seedBill({ billNumber: 'Draft 1', isDraft: true })
    const filed = await seedBill({ billNumber: 'HB 9' })
    await mute('ben', draft)
    await mute('cara', draft)
    await mute('cara', filed)

    const res = await request(`/api/bills/${draft}/link`, 'POST', 'ann', { filedBillId: filed })
    expect(res.status).toBe(200)

    expect(await mutedOnPage('ben', filed)).toBe(true)
    expect(await mutedOnPage('cara', filed)).toBe(true)
    expect(await mutedOnPage('ann', filed)).toBe(false)
  })

  describe('in a companion group, which shares one conversation', () => {
    let companion: string

    /** Puts the bills in one group, keyed by the smallest id as recomputeGroups keys it. */
    async function group(...billIds: string[]) {
      const key = [...billIds].sort()[0]
      for (const id of billIds) await getDb(env.DB).update(bills).set({ groupKey: key }).where(eq(bills.id, id))
    }

    beforeEach(async () => {
      companion = await seedBill({ billNumber: 'SB 1' })
      await group(billId, companion)
    })

    it('silences replies on every bill in the group when the member mutes one of them', async () => {
      await comment('ben', '<p>On the house bill</p>')
      await comment('cara', '<p>On the senate bill</p>', companion)
      await mute('ben')
      send.mockClear()

      const commentId = await comment('ann', '<p>On the companion</p>', companion)

      expect(await inboxFor('ben', commentId)).toEqual([])
      expect(await inboxFor('cara', commentId)).toEqual(['reply'])
      expect(emailedTo()).toEqual(['cara@example.com'])
    })

    it('shows the conversation as muted on every bill in the group', async () => {
      await mute('ben', companion)

      expect(await mutedOnPage('ben')).toBe(true)
      expect(await mutedOnPage('ben', companion)).toBe(true)
      expect(await mutedOnPage('cara')).toBe(false)
    })

    it('unmutes the whole group from any of its bills', async () => {
      await comment('ben', '<p>First</p>')
      await mute('ben')
      await mute('ben', companion)

      await unmute('ben', companion)

      expect(await mutedOnPage('ben')).toBe(false)
      expect(await mutedOnPage('ben', companion)).toBe(false)
      send.mockClear()
      const commentId = await comment('ann', '<p>Back again</p>', companion)
      expect(await inboxFor('ben', commentId)).toEqual(['reply'])
      expect(emailedTo()).toEqual(['ben@example.com'])
    })

    it('silences the group when the member mutes from a reply email', async () => {
      await comment('ben', '<p>First</p>')
      const { ben } = await replyEmails()
      expect((await oneClick(pathOf(oneClickUrl(ben)))).status).toBe(200)
      send.mockClear()

      const commentId = await comment('ann', '<p>On the companion</p>', companion)

      expect(await inboxFor('ben', commentId)).toEqual([])
      expect(send).not.toHaveBeenCalled()
    })

    it('leaves a mute with the bill it was set on when the group splits', async () => {
      await mute('ben', companion)
      await getDb(env.DB).update(bills).set({ groupKey: null }).where(eq(bills.id, companion))
      await getDb(env.DB).update(bills).set({ groupKey: null }).where(eq(bills.id, billId))

      expect(await mutedOnPage('ben', companion)).toBe(true)
      expect(await mutedOnPage('ben')).toBe(false)
    })
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

  // The page shows Mute only to a participant: someone the reply fan-out would
  // notify. The route returns that as `commentsParticipant`, decided by the same
  // helper the fan-out uses, so the control and the emails cannot disagree.
  describe('who the bill page offers Mute to', () => {
    async function participantOnPage(as: string, onBill = billId) {
      const res = await request(`/api/bills/${onBill}`, 'GET', as)
      expect(res.status).toBe(200)
      return (await res.json() as { commentsParticipant: boolean }).commentsParticipant
    }
    const react = (as: string, onComment: string) =>
      request(`/api/comments/${onComment}/reactions`, 'POST', as, { emoji: '\u{1F44D}' })
    async function putInGroup(...billIds: string[]) {
      const key = [...billIds].sort()[0]
      for (const id of billIds) await getDb(env.DB).update(bills).set({ groupKey: key }).where(eq(bills.id, id))
    }

    it('offers Mute to a member who commented on the bill', async () => {
      await comment('ben', '<p>My view</p>')

      expect(await participantOnPage('ben')).toBe(true)
    })

    it('offers no Mute to a member with no involvement in the bill', async () => {
      await comment('ben', '<p>My view</p>')

      expect(await participantOnPage('cara')).toBe(false)
    })

    it('offers no Mute to a member who was only mentioned', async () => {
      await comment('ann', `<p>${userMention(ids.cara, 'Cara')} thoughts?</p>`)

      expect(await participantOnPage('cara')).toBe(false)
    })

    it('offers no Mute to a member who has only reacted', async () => {
      const commentId = await comment('ann', '<p>A thought</p>')
      expect((await react('cara', commentId)).status).toBe(200)

      expect(await participantOnPage('cara')).toBe(false)
    })

    it('offers no Mute to a member who has only voted on the bill or written a note on it', async () => {
      expect((await request(`/api/bills/${billId}/votes`, 'POST', 'cara', { position: 'support' })).status).toBeLessThan(300)
      expect((await request(`/api/bills/${billId}/note`, 'PUT', 'cara', { content: '<p>Private</p>' })).status).toBe(200)

      expect(await participantOnPage('cara')).toBe(false)
    })

    it('offers no Mute to an admin who has not commented, and offers it once they do', async () => {
      expect(await participantOnPage('ann')).toBe(false)

      await comment('ann', '<p>Admin view</p>')

      expect(await participantOnPage('ann')).toBe(true)
    })

    it('stops offering Mute once the member\'s only comment is deleted', async () => {
      const commentId = await comment('ben', '<p>Never mind</p>')
      expect(await participantOnPage('ben')).toBe(true)

      expect((await request(`/api/comments/${commentId}`, 'DELETE', 'ben')).status).toBe(204)

      expect(await participantOnPage('ben')).toBe(false)
    })

    it('keeps offering Mute while one live comment remains after another is deleted', async () => {
      const first = await comment('ben', '<p>First</p>')
      await comment('ben', '<p>Second</p>')

      await request(`/api/comments/${first}`, 'DELETE', 'ben')

      expect(await participantOnPage('ben')).toBe(true)
    })

    it('still reports a mute on a bill the member never commented on, so the page can offer Unmute', async () => {
      await mute('cara')

      expect(await mutedOnPage('cara')).toBe(true)
      expect(await participantOnPage('cara')).toBe(false)
    })

    it('reports a muted participant as both, and unmuting leaves them a participant', async () => {
      await comment('ben', '<p>My view</p>')
      await mute('ben')

      expect(await mutedOnPage('ben')).toBe(true)
      expect(await participantOnPage('ben')).toBe(true)

      await unmute('ben')

      expect(await mutedOnPage('ben')).toBe(false)
      expect(await participantOnPage('ben')).toBe(true)
    })

    // The page hides Mute for a member whose "Replies on bills you've commented
    // on" setting is off (it reads the setting from the signed-in user), so the
    // route keeps reporting participation by comments alone.
    it('still reports a member who turned replies off as a participant, though they are notified of nothing', async () => {
      await member('Dee')
      await getDb(env.DB).update(users).set({ emailRepliesEnabled: 0 }).where(eq(users.id, ids.dee))
      await comment('dee', '<p>Quiet one</p>')
      send.mockClear()

      expect(await participantOnPage('dee')).toBe(true)
      const commentId = await comment('ann', '<p>Reply</p>')
      expect(await inboxFor('dee', commentId)).toEqual([])
      expect(emailedTo()).not.toContain('dee@example.com')
    })

    describe('in a companion group, which shares one conversation', () => {
      let companion: string

      beforeEach(async () => {
        companion = await seedBill({ billNumber: 'SB 1' })
        await putInGroup(billId, companion)
      })

      it('offers Mute on every bill in the group to a member who commented on only one of them', async () => {
        await comment('ben', '<p>On the senate bill</p>', companion)

        expect(await participantOnPage('ben')).toBe(true)
        expect(await participantOnPage('ben', companion)).toBe(true)
        expect(await participantOnPage('cara')).toBe(false)
        expect(await participantOnPage('cara', companion)).toBe(false)
      })

      it('offers no Mute for a group once the only comment in it is deleted', async () => {
        const commentId = await comment('ben', '<p>On the senate bill</p>', companion)
        await request(`/api/comments/${commentId}`, 'DELETE', 'ben')

        expect(await participantOnPage('ben')).toBe(false)
      })

      it('does not carry a comment on an unrelated bill into the group', async () => {
        const unrelated = await seedBill({ billNumber: 'HB 77' })
        await comment('ben', '<p>Somewhere else</p>', unrelated)

        expect(await participantOnPage('ben')).toBe(false)
        expect(await participantOnPage('ben', unrelated)).toBe(true)
      })

      it('shows a muted group as muted to a member who never commented in it', async () => {
        await mute('cara', companion)

        expect(await mutedOnPage('cara')).toBe(true)
        expect(await participantOnPage('cara')).toBe(false)
      })
    })

    // The control and the emails decide with one helper, so for every kind of
    // member the flag says yes exactly when a new comment would notify them.
    it('agrees with the reply fan-out for each kind of member', async () => {
      const companion = await seedBill({ billNumber: 'SB 1' })
      await putInGroup(billId, companion)
      for (const name of ['Dan', 'Eve', 'Finn', 'Gus']) await member(name)
      await comment('ben', '<p>On this bill</p>')
      await comment('cara', '<p>On the companion</p>', companion)
      const soonGone = await comment('dan', '<p>Deleted soon</p>')
      await request(`/api/comments/${soonGone}`, 'DELETE', 'dan')
      const anchor = await comment('ann', `<p>${userMention(ids.eve, 'Eve')} look</p>`)
      expect((await react('finn', anchor)).status).toBe(200)
      // Gus has no involvement at all.
      const everyone = ['ben', 'cara', 'dan', 'eve', 'finn', 'gus']

      const flags: Record<string, boolean> = {}
      for (const who of everyone) flags[who] = await participantOnPage(who)
      send.mockClear()
      const newComment = await comment('ann', '<p>A new reply</p>')
      const notified: Record<string, boolean> = {}
      for (const who of everyone) notified[who] = (await inboxFor(who, newComment)).includes('reply')

      expect(flags).toEqual({ ben: true, cara: true, dan: false, eve: false, finn: false, gus: false })
      expect(notified).toEqual(flags)
    })
  })
})
