import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { env } from 'cloudflare:test'
import { eq, inArray } from 'drizzle-orm'
import { appFetch, resetDb, applyMigrations, seedUser, seedSession, seedBill, seedComment } from '../helpers'
import { getDb } from '../../src/db/client'
import { associationConfig, bills, feedEvents } from '../../src/db/schema'
import { runDigest } from '../../src/lib/digest'
import * as filterTable from '../../src/routes/billsApi/filterTable'
import { renderDigestEmail, digestSubject, type DigestEvent, type NewMatchDigestItem, type ViewDigestSection } from '../../src/lib/digestEmail'

// #449: a member includes a saved view in their digest. Each included view gets
// its own section, "In your <view> view", of bills that entered it and activity
// on bills already in it, capped with "and N more". A bill that is also a
// priority bill is shown under priority bills only, and a view with no news adds
// nothing. Seams: the renderer (sections in, HTML out) and the digest job with
// outgoing email captured.

const APP = 'https://app.example.test'
const CARDS = /box-shadow:0 1px 3px/g
const cards = (html: string) => (html.match(CARDS) ?? []).length
const text = (html: string) => html.replace(/<[^>]*>/g, ' ').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ')
const j = (o: unknown) => JSON.stringify(o)
const action = (newValue: string) => j({ changes: [{ changeType: 'action_added', newValue }] })

function ev(over: Partial<DigestEvent> & Pick<DigestEvent, 'billId' | 'billNumber'>): DigestEvent {
  return {
    type: 'bill_updated', metadata: action('Referred'), createdAt: '2026-06-10 09:00:00',
    billTitle: 'An Act Relating to Roads', billState: 'RI', billSession: '2026', priority: null,
    summary: null, userName: null, ...over,
  }
}
const newBill = (billId: string, billNumber: string, over: Partial<NewMatchDigestItem> = {}): NewMatchDigestItem =>
  ({ billId, billNumber, billTitle: 'An Act Relating to Bridges', billState: 'RI', billSession: '2026', relevanceScore: null, ...over })
const section = (name: string, over: Partial<ViewDigestSection> = {}): ViewDigestSection =>
  ({ viewId: `id-${name}`, name, slug: name.toLowerCase(), events: [], newBills: [], ...over })
const render = (views: ViewDigestSection[], extra: Partial<Parameters<typeof renderDigestEmail>[0]> = {}) =>
  renderDigestEmail({ events: [], views, assocName: 'Test Org', appUrl: APP, periodStart: '2026-06-10 00:00:00', periodEnd: '2026-06-11 00:00:00', ...extra })

describe('renderDigestEmail: saved view sections', () => {
  it('gives a view its own section, headed "In your <view> view", with an event card and a new-bill card', () => {
    const html = render([section('Transportation', {
      events: [ev({ billId: 'b1', billNumber: 'H 101', metadata: action('Passed committee') })],
      newBills: [newBill('b2', 'H 202')],
    })])
    expect(text(html)).toContain('In your Transportation view')
    expect(cards(html)).toBe(2)
    expect(text(html)).toContain('H 101')
    expect(text(html)).toContain('Action: Passed committee')
    expect(text(html)).toContain('H 202')
  })

  it('gives each included view its own section, in the order given', () => {
    const html = render([
      section('Transportation', { newBills: [newBill('b1', 'H 101')] }),
      section('Elections', { newBills: [newBill('b2', 'H 202')] }),
    ])
    const t = text(html)
    expect(t.indexOf('In your Transportation view')).toBeGreaterThan(0)
    expect(t.indexOf('In your Elections view')).toBeGreaterThan(t.indexOf('In your Transportation view'))
  })

  it('leaves out a view with nothing new, and the digest has no view section at all', () => {
    const html = render([section('Transportation'), section('Elections', { newBills: [newBill('b2', 'H 202')] })])
    expect(text(html)).not.toContain('In your Transportation view')
    expect(text(html)).toContain('In your Elections view')
  })

  it('caps a view at five cards and says "and N more", linking to the view', () => {
    const newBills = Array.from({ length: 8 }, (_, i) => newBill(`b${i}`, `H ${100 + i}`))
    const html = render([section('Transportation', { slug: 'roads', newBills })])
    expect(cards(html)).toBe(5)
    expect(text(html)).toContain('and 3 more')
    expect(html).toContain(`href="${APP}/bills?view=roads"`)
  })

  it('has no "and N more" at or under the cap', () => {
    const newBills = Array.from({ length: 5 }, (_, i) => newBill(`b${i}`, `H ${100 + i}`))
    const html = render([section('Transportation', { newBills })])
    expect(cards(html)).toBe(5)
    expect(text(html)).not.toContain(' more')
  })

  it('counts the cap in cards, so a companion group is one card however many of its bills moved', () => {
    const events = [
      ev({ billId: 'h1', billNumber: 'H 101', billGroupKey: 'h1' }),
      ev({ billId: 's1', billNumber: 'S 202', billGroupKey: 'h1' }),
      ...Array.from({ length: 5 }, (_, i) => ev({ billId: `x${i}`, billNumber: `H ${300 + i}` })),
    ]
    const html = render([section('Transportation', { events })])
    expect(cards(html)).toBe(5)
    expect(text(html)).toContain('and 1 more')
  })

  it('shows a bill that has both news and activity once, as its activity card', () => {
    const html = render([section('Transportation', {
      events: [ev({ billId: 'b1', billNumber: 'H 101' })],
      newBills: [newBill('b1', 'H 101'), newBill('b2', 'H 202')],
    })])
    expect(cards(html)).toBe(2)
  })

  it('lists an admin\'s and a member\'s view cards alike, with no "Set priority" link on either', () => {
    const views = [section('Transportation', { newBills: [newBill('b1', 'H 101')] })]
    expect(render(views, { forMember: false })).not.toContain('Set priority')
    expect(render(views, { forMember: true })).not.toContain('Set priority')
  })

  it('names the view safely in the header', () => {
    const html = render([section('<b>Roads</b> & "Bridges"', { newBills: [newBill('b1', 'H 101')] })])
    expect(html).not.toContain('<b>Roads</b>')
    expect(html).toContain('In your &lt;b&gt;Roads&lt;/b&gt; &amp; &quot;Bridges&quot; view')
  })

  it('states a view-only digest in the headline, counting each bill once across views', () => {
    const html = render([
      section('Transportation', { newBills: [newBill('b1', 'H 101'), newBill('b2', 'H 202')] }),
      section('Elections', { newBills: [newBill('b2', 'H 202')] }),
    ])
    expect(text(html)).toContain('2 bills in your saved views in the last day')
  })

  it('lists the kinds in the contents box when views join priority bills and new matches', () => {
    const html = render([section('Transportation', { newBills: [newBill('b1', 'H 101')] })], {
      events: [ev({ billId: 'p1', billNumber: 'H 900', priority: 'high' })],
      newMatches: [newBill('n1', 'H 800')],
    })
    const t = text(html)
    expect(t).toContain('Your digest for the last day')
    expect(t).toContain('In this digest')
    expect(t).toContain('1 priority bill updated')
    expect(t).toContain('1 new match')
    expect(t).toContain('1 bill in Transportation')
  })

  it('leaves a digest with no views as it was', () => {
    const plain = render([], { events: [ev({ billId: 'p1', billNumber: 'H 900', priority: 'high' })] })
    expect(text(plain)).toContain('1 priority bill was updated in the last day')
    expect(text(plain)).not.toContain('In your')
  })
})

describe('digestSubject: saved view bills', () => {
  it('names the bills in saved views after the other kinds', () => {
    expect(digestSubject({ updatedBills: 2, newMatches: 1, viewBills: 3, cadence: 'daily' }))
      .toBe('Your daily digest: 2 updated bills, 1 new match, 3 bills in your saved views')
  })
  it('says "bill" for one, and names only the kinds present', () => {
    expect(digestSubject({ updatedBills: 0, newMatches: 0, viewBills: 1, cadence: 'weekly' })).toBe('Your weekly digest: 1 bill in your saved views')
  })
  it('is unchanged without views', () => {
    expect(digestSubject({ updatedBills: 2, newMatches: 0, cadence: 'daily' })).toBe('Your daily digest: 2 updated bills')
  })
})

describe('runDigest: saved views', () => {
  let emails: Array<{ to: string[]; subject: string; html: string }>
  let adminCookie: string
  let ada: { id: string; cookie: string }
  let ben: { id: string; cookie: string }
  let admin: string
  const db = () => getDb(env.DB)
  const to = (addr: string) => emails.filter(e => e.to[0] === addr)
  const ago = (h: number) => new Date(Date.now() - h * 3600_000).toISOString().slice(0, 19).replace('T', ' ')
  const old = () => ago(24 * 30)

  async function person(email: string, role: 'admin' | 'member', opts: { digest?: boolean; matches?: boolean } = {}) {
    const id = await seedUser({ email, role, emailDigestEnabled: opts.digest !== false, emailDigestMatchesEnabled: opts.matches !== false })
    const token = await seedSession(id)
    return { id, cookie: `session=${token}` }
  }
  async function makeView(id: string, name: string, query: string) {
    await env.DB.prepare('INSERT INTO saved_views (id, name, query, slug, created_by, display_order) VALUES (?, ?, ?, ?, ?, 0)')
      .bind(id, name, query, name.toLowerCase().replace(/\s+/g, '-'), admin).run()
  }
  async function subscribe(cookie: string, viewId: string, subscribed = true) {
    const res = await appFetch(`/api/views/${viewId}/subscription`, { method: 'PUT', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ subscribed }) })
    expect(res.status).toBe(200)
  }
  // A bill older than the digest window, so it is in a view but is not news.
  const settled = (over: Parameters<typeof seedBill>[0]) => seedBill(over).then(async id => { await db().update(bills).set({ createdAt: old() }).where(eq(bills.id, id)); return id })
  async function event(billId: string, metadata: unknown = { changes: [{ changeType: 'action_added', newValue: 'Referred' }] }, createdAt = ago(2)) {
    await db().insert(feedEvents).values({ id: crypto.randomUUID(), type: 'bill_updated' as never, billId, userId: 'system', metadata: JSON.stringify(metadata), createdAt })
  }

  beforeEach(async () => {
    await resetDb(); await applyMigrations()
    emails = []
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: { body: string }) => { emails.push(JSON.parse(init.body)); return new Response('{}', { status: 200 }) }))
    await db().insert(associationConfig).values({ key: 'modules', value: JSON.stringify({ 'email-digest': true }) })
    const a = await person('admin@example.com', 'admin'); admin = a.id; adminCookie = a.cookie
    ada = await person('ada@example.com', 'member', { matches: false })
    ben = await person('ben@example.com', 'member', { matches: false })
    await makeView('v-ri', 'Transportation', 'state=RI')
  })
  afterEach(() => { vi.unstubAllGlobals() })

  it('sends a subscribed view\'s news to that member and to nobody else', async () => {
    await seedBill({ billNumber: 'H 101', state: 'RI', session: '2026' })
    await seedBill({ billNumber: 'H 202', state: 'UT', session: '2026' })
    await subscribe(ada.cookie, 'v-ri')

    await runDigest(env as never, db())

    expect(emails).toHaveLength(1)
    expect(emails[0].to).toEqual(['ada@example.com'])
    expect(text(emails[0].html)).toContain('In your Transportation view')
    expect(text(emails[0].html)).toContain('H 101')
    expect(text(emails[0].html)).not.toContain('H 202')
    expect(emails[0].subject).toBe('Your daily digest: 1 bill in your saved views')
  })

  it('sends a member who did not subscribe nothing, whatever the view holds', async () => {
    await seedBill({ billNumber: 'H 101', state: 'RI', session: '2026' })
    await subscribe(ada.cookie, 'v-ri')
    await runDigest(env as never, db())
    expect(to('ben@example.com')).toHaveLength(0)
    expect(to('admin@example.com')).toHaveLength(0)
  })

  it('adds nothing for a view that has no matches, and sends no digest when that is all there is', async () => {
    await seedBill({ billNumber: 'H 202', state: 'UT', session: '2026' })
    await subscribe(ada.cookie, 'v-ri')
    const result = await runDigest(env as never, db())
    expect(emails).toHaveLength(0)
    expect(result).toEqual({ ok: true, recipients: 0, sent: 0, failed: 0 })
  })

  it('adds nothing for a view whose bills were settled before the window and had no activity in it', async () => {
    await settled({ billNumber: 'H 101', state: 'RI', session: '2026' })
    await subscribe(ada.cookie, 'v-ri')
    await runDigest(env as never, db())
    expect(emails).toHaveLength(0)
  })

  it('lists activity on a bill already in the view, without a priority', async () => {
    const id = await settled({ billNumber: 'H 101', state: 'RI', session: '2026' })
    await event(id, { changes: [{ changeType: 'action_added', newValue: 'Passed House committee' }] })
    await subscribe(ada.cookie, 'v-ri')

    await runDigest(env as never, db())

    expect(emails).toHaveLength(1)
    expect(text(emails[0].html)).toContain('In your Transportation view')
    expect(text(emails[0].html)).toContain('Action: Passed House committee')
  })

  it('ignores an event outside the window and a suppressed one', async () => {
    const id = await settled({ billNumber: 'H 101', state: 'RI', session: '2026' })
    await event(id, undefined, ago(24 * 5))
    await db().insert(feedEvents).values({ id: crypto.randomUUID(), type: 'bill_updated' as never, billId: id, userId: 'system', metadata: action('Hidden'), createdAt: ago(2), suppressed: true })
    await subscribe(ada.cookie, 'v-ri')
    await runDigest(env as never, db())
    expect(emails).toHaveLength(0)
  })

  it('shows a priority bill once, under priority bills, and not again in the view', async () => {
    const pri = await settled({ billNumber: 'H 101', state: 'RI', session: '2026', priority: 'high' })
    await event(pri, { changes: [{ changeType: 'action_added', newValue: 'Signed' }] })
    await seedBill({ billNumber: 'H 202', state: 'RI', session: '2026' })
    await subscribe(ada.cookie, 'v-ri')

    await runDigest(env as never, db())

    const mine = to('ada@example.com')[0]
    const html = mine.html
    const t = text(html)
    expect(t).toContain('1 priority bill was updated')
    expect(t).toContain('In your Transportation view')
    expect(cards(html)).toBe(2)
    // H 101's card is above the view section, and the view lists only H 202.
    expect(t.indexOf('H 101')).toBeGreaterThan(-1)
    expect(t.indexOf('H 101')).toBeLessThan(t.indexOf('In your Transportation view'))
    const viewPart = t.slice(t.indexOf('In your Transportation view'))
    expect(viewPart).toContain('H 202')
    expect(viewPart).not.toContain('H 101')
    expect(mine.subject).toBe('Your daily digest: 1 updated bill, 1 bill in your saved views')
  })

  it('drops the view section when its only news is a priority bill', async () => {
    const pri = await settled({ billNumber: 'H 101', state: 'RI', session: '2026', priority: 'high' })
    await event(pri)
    await subscribe(ada.cookie, 'v-ri')

    await runDigest(env as never, db())

    expect(text(to('ada@example.com')[0].html)).not.toContain('In your Transportation view')
    expect(to('ada@example.com')[0].subject).toBe('Your daily digest: 1 updated bill')
  })

  it('caps the section at five and counts every bill in the subject', async () => {
    for (let i = 1; i <= 8; i++) await seedBill({ billNumber: `H ${100 + i}`, state: 'RI', session: '2026' })
    await subscribe(ada.cookie, 'v-ri')

    await runDigest(env as never, db())

    expect(cards(emails[0].html)).toBe(5)
    expect(text(emails[0].html)).toContain('and 3 more')
    expect(emails[0].subject).toBe('Your daily digest: 8 bills in your saved views')
    expect(emails[0].html).toContain('/bills?view=transportation')
  })

  it('counts a companion group once, in the cards and in the subject', async () => {
    await seedBill({ id: 'a-house', billNumber: 'H 101', state: 'RI', session: '2026' })
    await seedBill({ id: 'b-senate', billNumber: 'S 202', state: 'RI', session: '2026' })
    await db().update(bills).set({ groupKey: 'a-house' }).where(inArray(bills.id, ['a-house', 'b-senate']))
    await seedBill({ billNumber: 'H 303', state: 'RI', session: '2026' })
    await subscribe(ada.cookie, 'v-ri')

    await runDigest(env as never, db())

    expect(cards(emails[0].html)).toBe(2)
    expect(emails[0].subject).toBe('Your daily digest: 2 bills in your saved views')
  })

  it('keeps the subject and headline consistent with the priority and new-match counts', async () => {
    const m = await person('opt@example.com', 'member', { matches: true })
    const p1 = await settled({ billNumber: 'P 1', state: 'UT', session: '2026', priority: 'high' })
    const p2 = await settled({ billNumber: 'P 2', state: 'UT', session: '2026', priority: 'low' })
    await event(p1); await event(p2)
    await seedBill({ billNumber: 'NM 1', state: 'UT', session: '2026', matchType: 'keyword', matchProvenance: 'routine', newMatchAt: ago(1), relevanceScore: 50 })
    await seedBill({ billNumber: 'V 1', state: 'RI', session: '2026' })
    await seedBill({ billNumber: 'V 2', state: 'RI', session: '2026' })
    await seedBill({ billNumber: 'V 3', state: 'RI', session: '2026' })
    await subscribe(m.cookie, 'v-ri')

    await runDigest(env as never, db())

    const mine = to('opt@example.com')[0]
    expect(mine.subject).toBe('Your daily digest: 2 updated bills, 1 new match, 3 bills in your saved views')
    const t = text(mine.html)
    expect(t).toContain('Your digest for the last day')
    expect(t).toContain('2 priority bills updated')
    expect(t).toContain('1 new match')
    expect(t).toContain('3 bills in Transportation')
    // Everyone else's subject is as #638 left it.
    expect(to('admin@example.com')[0].subject).toBe('Your daily digest: 2 updated bills, 1 new match')
    expect(to('ada@example.com')[0].subject).toBe('Your daily digest: 2 updated bills')
  })

  it('gives an admin the section too, beside the new-match section they always get', async () => {
    await seedBill({ billNumber: 'NM 1', state: 'UT', session: '2026', matchType: 'keyword', matchProvenance: 'routine', newMatchAt: ago(1), relevanceScore: 50 })
    await seedBill({ billNumber: 'V 1', state: 'RI', session: '2026' })
    await subscribe(adminCookie, 'v-ri')

    await runDigest(env as never, db())

    const mine = to('admin@example.com')[0]
    expect(text(mine.html)).toContain('In your Transportation view')
    expect(text(mine.html)).toContain('1 new match')
    expect(mine.html.match(/>New · Set priority</g)).toHaveLength(1)
    expect(mine.subject).toBe('Your daily digest: 1 new match, 1 bill in your saved views')
  })

  it('gives a member who turned new matches off the view section but not the matches', async () => {
    await seedBill({ billNumber: 'NM 1', state: 'UT', session: '2026', matchType: 'keyword', matchProvenance: 'routine', newMatchAt: ago(1), relevanceScore: 50 })
    await seedBill({ billNumber: 'V 1', state: 'RI', session: '2026' })
    await subscribe(ada.cookie, 'v-ri')

    await runDigest(env as never, db())

    const mine = to('ada@example.com')[0]
    expect(text(mine.html)).toContain('In your Transportation view')
    expect(text(mine.html)).not.toContain('NM 1')
    expect(mine.subject).toBe('Your daily digest: 1 bill in your saved views')
  })

  it('does not send a digest to a member who has turned theirs off', async () => {
    const off = await person('off@example.com', 'member', { digest: false })
    await seedBill({ billNumber: 'V 1', state: 'RI', session: '2026' })
    await subscribe(off.cookie, 'v-ri')
    await runDigest(env as never, db())
    expect(to('off@example.com')).toHaveLength(0)
  })

  it('sends nothing when the instance digest is off', async () => {
    await db().update(associationConfig).set({ value: JSON.stringify({ 'email-digest': false }) }).where(eq(associationConfig.key, 'modules'))
    await seedBill({ billNumber: 'V 1', state: 'RI', session: '2026' })
    await subscribe(ada.cookie, 'v-ri')
    await runDigest(env as never, db())
    expect(emails).toHaveLength(0)
  })

  it('follows an edit to the view: the filter it has now decides what is listed', async () => {
    await seedBill({ billNumber: 'H 101', state: 'RI', session: '2026' })
    await seedBill({ billNumber: 'H 202', state: 'UT', session: '2026' })
    await subscribe(ada.cookie, 'v-ri')
    await appFetch('/api/admin/views/v-ri', { method: 'PUT', headers: { Cookie: adminCookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ query: 'state=UT' }) })

    await runDigest(env as never, db())

    expect(text(emails[0].html)).toContain('H 202')
    expect(text(emails[0].html)).not.toContain('H 101')
  })

  it('drops a deleted view out of the member\'s digest, with its subscription gone', async () => {
    await seedBill({ billNumber: 'H 101', state: 'RI', session: '2026' })
    await subscribe(ada.cookie, 'v-ri')
    expect((await appFetch('/api/admin/views/v-ri', { method: 'DELETE', headers: { Cookie: adminCookie } })).status).toBe(204)

    await runDigest(env as never, db())

    expect(emails).toHaveLength(0)
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM saved_view_subscriptions').first<{ n: number }>())!.n).toBe(0)
  })

  it('runs a per-member filter for each subscriber, so "my bills" is each one\'s own', async () => {
    await makeView('v-mine', 'Mine', 'myBills=1')
    const a = await seedBill({ billNumber: 'H 101', state: 'RI', session: '2026' })
    const b = await seedBill({ billNumber: 'H 202', state: 'RI', session: '2026' })
    await seedComment(a, ada.id)
    await seedComment(b, ben.id)
    await subscribe(ada.cookie, 'v-mine'); await subscribe(ben.cookie, 'v-mine')

    await runDigest(env as never, db())

    expect(text(to('ada@example.com')[0].html)).toContain('H 101')
    expect(text(to('ada@example.com')[0].html)).not.toContain('H 202')
    expect(text(to('ben@example.com')[0].html)).toContain('H 202')
    expect(text(to('ben@example.com')[0].html)).not.toContain('H 101')
  })

  it('skips a view whose stored query cannot be read, and still sends the rest', async () => {
    await makeView('v-bad', 'Broken', Array.from({ length: 60 }, (_, i) => `subject=RI%3AS${i}`).join('&'))
    await seedBill({ billNumber: 'H 101', state: 'RI', session: '2026' })
    await subscribe(ada.cookie, 'v-bad'); await subscribe(ada.cookie, 'v-ri')

    await runDigest(env as never, db())

    expect(text(emails[0].html)).toContain('In your Transportation view')
    expect(text(emails[0].html)).not.toContain('In your Broken view')
  })

  it('lists activity on a companion whose group meets the view, as the list shows the group', async () => {
    // Only the House bill is in Rhode Island, so only it meets the view, but the list shows the group.
    await settled({ id: 'a-house', billNumber: 'H 101', state: 'RI', session: '2026' })
    const senate = await settled({ id: 'b-senate', billNumber: 'S 202', state: 'UT', session: '2026' })
    await db().update(bills).set({ groupKey: 'a-house' }).where(inArray(bills.id, ['a-house', 'b-senate']))
    const other = await settled({ billNumber: 'U 303', state: 'UT', session: '2026' })
    await event(senate, { changes: [{ changeType: 'action_added', newValue: 'Passed Senate committee' }] })
    await event(other, { changes: [{ changeType: 'action_added', newValue: 'Unrelated' }] })
    await subscribe(ada.cookie, 'v-ri')

    await runDigest(env as never, db())

    const html = to('ada@example.com')[0].html
    expect(cards(html)).toBe(1)
    expect(text(html)).toContain('S 202: Action: Passed Senate committee')
    expect(text(html)).not.toContain('Unrelated')
  })

  it('skips a view whose query makes the SQL throw, and still sends the rest of every digest', async () => {
    await makeView('v-big', 'Huge', Array.from({ length: 150 }, (_, i) => `status=S${i}`).join('&'))
    await seedBill({ billNumber: 'H 101', state: 'RI', session: '2026' })
    const pri = await settled({ billNumber: 'P 1', state: 'UT', session: '2026', priority: 'high' })
    await event(pri)
    await subscribe(ada.cookie, 'v-big'); await subscribe(ada.cookie, 'v-ri')
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})

    await runDigest(env as never, db())

    const mine = text(to('ada@example.com')[0].html)
    expect(mine).toContain('In your Transportation view')
    expect(mine).not.toContain('In your Huge view')
    expect(to('ben@example.com')).toHaveLength(1)
    expect(text(to('ben@example.com')[0].html)).toContain('P 1')
    expect(err.mock.calls.some(c => String(c[0]).includes('v-big'))).toBe(true)
    err.mockRestore()
  })

  it('logs a view whose query could not be read because the database failed, and skips only that view', async () => {
    await makeView('v-ut', 'Elections', 'state=UT')
    await seedBill({ billNumber: 'H 101', state: 'RI', session: '2026' })
    await seedBill({ billNumber: 'H 202', state: 'UT', session: '2026' })
    await subscribe(ada.cookie, 'v-ri'); await subscribe(ada.cookie, 'v-ut')
    const real = filterTable.buildBillsFilter
    vi.spyOn(filterTable, 'buildBillsFilter').mockImplementation(async (d, bf, ctx) => {
      if (bf.state.includes('UT')) throw new Error('D1 unavailable')
      return real(d, bf, ctx)
    })
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})

    await runDigest(env as never, db())

    const mine = text(to('ada@example.com')[0].html)
    expect(mine).toContain('In your Transportation view')
    expect(mine).not.toContain('In your Elections view')
    expect(err.mock.calls.some(c => String(c[0]).includes('v-ut'))).toBe(true)
    vi.restoreAllMocks()
  })

  it('stamps the window so the next run does not repeat the same news', async () => {
    await seedBill({ billNumber: 'H 101', state: 'RI', session: '2026' })
    await subscribe(ada.cookie, 'v-ri')
    await runDigest(env as never, db())
    expect(emails).toHaveLength(1)
    await runDigest(env as never, db())
    expect(emails).toHaveLength(1)
  })
})
