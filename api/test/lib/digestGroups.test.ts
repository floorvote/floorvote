import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { env } from 'cloudflare:test'
import { eq, inArray } from 'drizzle-orm'
import { resetDb, applyMigrations, seedUser, seedSession, seedBill } from '../helpers'
import { getDb } from '../../src/db/client'
import { associationConfig, bills, feedEvents } from '../../src/db/schema'
import { stubResend } from '../../../shared/emailTestKit'
import { runDigest } from '../../src/lib/digest'
import { groupByHand, splitFromGroup } from '../../src/lib/companionGroups'
import { renderDigestEmail, countNewMatches, type DigestEvent, type NewMatchDigestItem } from '../../src/lib/digestEmail'

// A companion group is one policy in the digest (#381): the events on every
// member roll into one card, each event labeled with its bill's number, and the
// card counts once in the headline, the contents box, and the subject.
// Seams: the renderer (events in, HTML out) and the digest job with outgoing
// email captured.

const APP = 'https://app.example.test'
const CARDS = /box-shadow:0 1px 3px/g
const cards = (html: string) => (html.match(CARDS) ?? []).length
const text = (html: string) => html.replace(/<[^>]*>/g, ' ').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ')

const j = (o: unknown) => JSON.stringify(o)
const action = (newValue: string) => j({ changes: [{ changeType: 'action_added', newValue }] })

function ev(over: Partial<DigestEvent> & Pick<DigestEvent, 'billId' | 'billNumber'>): DigestEvent {
  return {
    type: 'bill_updated', metadata: action('Referred'), createdAt: '2026-06-10 09:00:00',
    billTitle: 'An Act Relating to Elections', billState: 'RI', billSession: '2026', priority: 'high',
    summary: null, userName: null, ...over,
  }
}
const render = (events: DigestEvent[], extra: Partial<Parameters<typeof renderDigestEmail>[0]> = {}) =>
  renderDigestEmail({ events, assocName: 'Test Org', appUrl: APP, periodStart: '2026-06-10 00:00:00', periodEnd: '2026-06-11 00:00:00', ...extra })

describe('renderDigestEmail: companion groups', () => {
  const house = (over: Partial<DigestEvent> = {}) => ev({ billId: 'h1', billNumber: 'H 101', billGroupKey: 'h1', ...over })
  const senate = (over: Partial<DigestEvent> = {}) => ev({ billId: 's1', billNumber: 'S 202', billGroupKey: 'h1', ...over })

  it('rolls the events of both members into one card, each event labeled by its bill number', () => {
    const html = render([
      house({ metadata: action('Passed House committee'), createdAt: '2026-06-10 09:00:00' }),
      senate({ metadata: action('Reported from committee'), createdAt: '2026-06-10 10:00:00' }),
    ])
    expect(cards(html)).toBe(1)
    expect(text(html)).toContain('H 101: Action: Passed House committee')
    expect(text(html)).toContain('S 202: Action: Reported from committee')
  })

  it('names both bills in the card header', () => {
    const html = render([house(), senate({ createdAt: '2026-06-10 10:00:00' })])
    expect(html).toMatch(/>RI H 101</)
    expect(html).toMatch(/>RI S 202</)
  })

  it('counts a group once in the headline whatever the number of member bills that changed', () => {
    const html = render([
      house(), senate(),
      ev({ billId: 'x3', billNumber: 'H 303', billGroupKey: 'h1' }),
      ev({ billId: 'u1', billNumber: 'H 404' }),
    ])
    expect(cards(html)).toBe(2)
    expect(text(html)).toContain('2 priority bills were updated in the last day')
    expect(text(html)).toContain('2 priority bills were updated')
  })

  it('counts a lone group as one priority bill, in the headline and the contents box', () => {
    const only = render([house(), senate()])
    expect(text(only)).toContain('1 priority bill was updated in the last day')
    const both = render([house(), senate()], {
      newMatches: [{ billId: 'n1', billNumber: 'H 505', billTitle: 'A match', billState: 'RI', billSession: '2026', relevanceScore: 5 }],
    })
    expect(text(both)).toContain('1 priority bill updated')
    expect(text(both)).not.toContain('2 priority bills')
  })

  it('still labels a group\'s event by bill number when only one member had events', () => {
    const html = render([senate({ metadata: action('Signed') })])
    expect(cards(html)).toBe(1)
    expect(text(html)).toContain('S 202: Action: Signed')
  })

  it('links each event to its own bill, not the card\'s first', () => {
    const html = render([
      house({ metadata: action('Passed House committee') }),
      senate({ metadata: action('Reported from committee'), createdAt: '2026-06-10 10:00:00' }),
    ])
    const hrefOf = (row: string) => html.match(new RegExp(`<a href="([^"]*)"[^>]*>(?:(?!</a>).)*${row}`))![1]
    expect(hrefOf('Passed House committee')).toBe(`${APP}/RI/2026/H 101#section-actions`)
    expect(hrefOf('Reported from committee')).toBe(`${APP}/RI/2026/S 202#section-actions`)
  })

  it('lays the card\'s events out in time order even when the members\' events arrive interleaved', () => {
    const html = render([
      senate({ metadata: action('Third'), createdAt: '2026-06-10 12:00:00' }),
      house({ metadata: action('First'), createdAt: '2026-06-10 08:00:00' }),
      senate({ metadata: action('Second'), createdAt: '2026-06-10 10:00:00' }),
    ])
    const order = ['First', 'Second', 'Third'].map(w => text(html).indexOf(`Action: ${w}`))
    expect(order.every(i => i > 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })

  it('labels a draft member\'s events by its number, and shows an untitled draft as one', () => {
    const html = render([
      house({ billTitle: 'An Act Relating to Elections' }),
      ev({ billId: 's1', billNumber: 'DRAFT-7', billGroupKey: 'h1', billTitle: '', billIsDraft: true, metadata: j({ preview: 'on the draft' }), type: 'comment_added', userName: 'Ada', createdAt: '2026-06-10 10:00:00' }),
    ])
    expect(cards(html)).toBe(1)
    expect(text(html)).toContain('DRAFT-7: Ada: "on the draft"')
  })

  it('leaves an ungrouped bill\'s card as it was: no labels, its own badge only', () => {
    const html = render([ev({ billId: 'u1', billNumber: 'H 404', metadata: action('Referred') })])
    expect(cards(html)).toBe(1)
    expect(text(html)).toContain('Action: Referred')
    expect(text(html)).not.toContain('H 404: Action')
    expect(text(html)).not.toContain('<strong>')
  })

  it('keeps two groups\' cards apart', () => {
    const html = render([
      house(), senate(),
      ev({ billId: 'k1', billNumber: 'H 601', billGroupKey: 'k1' }),
      ev({ billId: 'k2', billNumber: 'S 602', billGroupKey: 'k1' }),
    ])
    expect(cards(html)).toBe(2)
  })
})

describe('runDigest: companion groups', () => {
  let resend: ReturnType<typeof stubResend>
  const sentEmails = (): Array<{ to: string[]; subject: string; html: string }> => resend.calls.map(c => c.body)
  const db = () => getDb(env.DB)
  const ago = (h: number) => new Date(Date.now() - h * 3600_000).toISOString().slice(0, 19).replace('T', ' ')

  async function group(...ids: string[]) {
    await db().update(bills).set({ groupKey: [...ids].sort()[0] }).where(inArray(bills.id, ids))
  }
  async function event(billId: string, type: string, metadata: unknown, createdAt = ago(2)) {
    await db().insert(feedEvents).values({ id: crypto.randomUUID(), type: type as never, billId, userId: 'system', metadata: JSON.stringify(metadata), createdAt })
  }

  beforeEach(async () => {
    await resetDb(); await applyMigrations()
    resend = stubResend()
    await db().insert(associationConfig).values({ key: 'modules', value: JSON.stringify({ 'email-digest': true }) })
    await seedSession(await seedUser({ email: 'ada@example.com', role: 'admin' }))
    // Ids sort a < b < c, so a group's key is its first bill's id.
    await seedBill({ id: 'a-house', billNumber: 'H 101', state: 'RI', session: '2026', priority: 'high' })
    await seedBill({ id: 'b-senate', billNumber: 'S 202', state: 'RI', session: '2026' })
    await seedBill({ id: 'c-third', billNumber: 'H 303', state: 'RI', session: '2026' })
    await seedBill({ id: 'd-alone', billNumber: 'H 404', state: 'RI', session: '2026', priority: 'low' })
  })
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

  it('sends one card for a group whose members both changed, and counts it once in the subject', async () => {
    await group('a-house', 'b-senate')
    await event('a-house', 'bill_updated', { changes: [{ changeType: 'action_added', newValue: 'Passed House committee' }] })
    await event('b-senate', 'bill_updated', { changes: [{ changeType: 'action_added', newValue: 'Reported from committee' }] })

    await runDigest(env as never, db())

    expect(sentEmails()).toHaveLength(1)
    expect(sentEmails()[0].subject).toBe('Your daily digest: 1 updated bill')
    expect(cards(sentEmails()[0].html)).toBe(1)
    expect(text(sentEmails()[0].html)).toContain('H 101: Action: Passed House committee')
    expect(text(sentEmails()[0].html)).toContain('S 202: Action: Reported from committee')
  })

  it('counts 3 member bills of one group and 1 other bill as 2 priority bills', async () => {
    // Every member holds a priority of its own (the group reads the latest), so each one's events qualify.
    await db().update(bills).set({ priority: 'medium', prioritySetAt: '2026-06-01 09:00:00' }).where(inArray(bills.id, ['b-senate', 'c-third']))
    await group('a-house', 'b-senate', 'c-third')
    for (const id of ['a-house', 'b-senate', 'c-third']) await event(id, 'bill_updated', { changes: [{ changeType: 'action_added', newValue: `Moved ${id}` }] })
    await event('d-alone', 'bill_updated', { changes: [{ changeType: 'action_added', newValue: 'Referred' }] })

    await runDigest(env as never, db())

    expect(sentEmails()[0].subject).toBe('Your daily digest: 2 updated bills')
    expect(cards(sentEmails()[0].html)).toBe(2)
    expect(text(sentEmails()[0].html)).toContain('2 priority bills were updated in the last day')
  })

  it('includes an event on a member with no priority of its own when the group has one', async () => {
    await group('a-house', 'b-senate')
    await event('b-senate', 'bill_updated', { changes: [{ changeType: 'action_added', newValue: 'Reported from committee' }] })

    await runDigest(env as never, db())

    expect(sentEmails()).toHaveLength(1)
    expect(text(sentEmails()[0].html)).toContain('S 202: Action: Reported from committee')
    // The card wears the group's priority.
    expect(sentEmails()[0].html).toContain('High')
  })

  it('still leaves out a group none of whose members has a priority, and an ungrouped bill without one', async () => {
    await db().update(bills).set({ priority: null }).where(eq(bills.id, 'a-house'))
    await group('a-house', 'b-senate')
    await event('b-senate', 'bill_updated', { changes: [{ changeType: 'action_added', newValue: 'Reported' }] })
    await event('c-third', 'bill_updated', { changes: [{ changeType: 'action_added', newValue: 'Referred' }] })

    const result = await runDigest(env as never, db())

    expect(sentEmails()).toHaveLength(0)
    expect(result).toEqual({ ok: true, recipients: 0, sent: 0, failed: 0 })
  })

  it('labels a group\'s lone event by its bill number', async () => {
    await group('a-house', 'b-senate')
    await event('b-senate', 'comment_added', { preview: 'Worth testifying on', commentId: 'c1' })

    await runDigest(env as never, db())

    expect(text(sentEmails()[0].html)).toContain('S 202:')
    expect(sentEmails()[0].subject).toBe('Your daily digest: 1 updated bill')
  })

  it('rolls up a group formed by hand the same way a provider\'s group does', async () => {
    const admin = await seedUser({ email: 'ops@example.com', role: 'admin' })
    expect('conflict' in await groupByHand(db(), 'a-house', 'c-third', admin)).toBe(false)
    await event('a-house', 'bill_updated', { changes: [{ changeType: 'action_added', newValue: 'Passed House committee' }] })
    await event('c-third', 'bill_updated', { changes: [{ changeType: 'action_added', newValue: 'Introduced in the Senate' }] })

    await runDigest(env as never, db())

    expect(cards(sentEmails()[0].html)).toBe(1)
    expect(text(sentEmails()[0].html)).toContain('H 303: Action: Introduced in the Senate')
    expect(sentEmails()[0].subject).toBe('Your daily digest: 1 updated bill')
  })

  it('treats the members as separate bills once the group is split, earlier events included', async () => {
    const admin = await seedUser({ email: 'ops@example.com', role: 'admin' })
    await group('a-house', 'b-senate')
    await db().update(bills).set({ priority: 'medium' }).where(eq(bills.id, 'b-senate'))
    await event('a-house', 'bill_updated', { changes: [{ changeType: 'action_added', newValue: 'Passed House committee' }] }, ago(10))
    await event('b-senate', 'bill_updated', { changes: [{ changeType: 'action_added', newValue: 'Reported from committee' }] }, ago(9))
    expect(await splitFromGroup(db(), 'b-senate', admin)).toBe(true)

    await runDigest(env as never, db())

    expect(sentEmails()[0].subject).toBe('Your daily digest: 2 updated bills')
    expect(cards(sentEmails()[0].html)).toBe(2)
    expect(text(sentEmails()[0].html)).not.toContain('S 202: Action')
  })

  it('leaves the digest of ungrouped bills as it was', async () => {
    await event('d-alone', 'bill_updated', { changes: [{ changeType: 'action_added', newValue: 'Referred' }] })

    await runDigest(env as never, db())

    expect(sentEmails()[0].subject).toBe('Your daily digest: 1 updated bill')
    expect(text(sentEmails()[0].html)).toContain('Action: Referred')
    expect(text(sentEmails()[0].html)).not.toContain('H 404: Action')
  })
})

describe('the sample digest', () => {
  it('shows a companion group as one card with its events labeled by bill, counted once', async () => {
    const { renderSampleEmail } = await import('../../src/lib/sampleEmails')
    const { subject, html } = renderSampleEmail('digest', APP)
    expect(subject).toBe('[Sample] Your daily digest: 3 updated bills, 3 new matches')
    expect(text(html)).toContain('3 priority bills updated')
    expect(text(html)).toContain('HB 1240: Action: Passed House committee')
    expect(text(html)).toContain('S 0733: Action: Reported from committee')
    // One card for the pair: each number is in the header once.
    expect(html.match(/>RI HB 1240</g)).toHaveLength(1)
    expect(html.match(/>RI S 0733</g)).toHaveLength(1)
  })
})


describe('renderDigestEmail: new-match companion groups (#638)', () => {
  const item = (billId: string, billNumber: string, over: Partial<NewMatchDigestItem> = {}): NewMatchDigestItem =>
    ({ billId, billNumber, billTitle: 'An Act Relating to Elections', billState: 'RI', billSession: '2026', relevanceScore: 5, ...over })
  const pair = [item('a', 'H 101', { billGroupKey: 'a' }), item('b', 'S 202', { billGroupKey: 'a', relevanceScore: 9 })]

  it('counts a group once however many members matched', () => {
    expect(countNewMatches(pair)).toBe(1)
    expect(countNewMatches([...pair, item('c', 'H 303')])).toBe(2)
    expect(countNewMatches([item('c', 'H 303'), item('d', 'H 404')])).toBe(2)
    expect(countNewMatches([])).toBe(0)
  })

  it('renders one card for the group, both bills in its header, and counts it once', () => {
    const html = render([], { newMatches: pair })
    expect(cards(html)).toBe(1)
    expect(html).toMatch(/>RI H 101</)
    expect(html).toMatch(/>RI S 202</)
    expect(text(html)).toContain('1 new match in')
    expect(text(html)).not.toContain('2 new matches')
  })

  it('heads the group\'s card with its most relevant member and takes the summary from whichever member has one', () => {
    const html = render([], { newMatches: [
      item('a', 'H 101', { billGroupKey: 'a', billTitle: 'Lower Title', relevanceScore: 2, summary: 'A summary' }),
      item('b', 'S 202', { billGroupKey: 'a', billTitle: 'Higher Title', relevanceScore: 9 }),
    ] })
    expect(text(html)).toContain('Higher Title')
    expect(text(html)).toContain('A summary')
  })

  it('ranks a group by its best member, so it is not capped out below a worse single bill', () => {
    const many = Array.from({ length: 10 }, (_, i) => item(`u${i}`, `H ${500 + i}`, { relevanceScore: 6 }))
    const html = render([], { newMatches: [...many, item('a', 'H 101', { billGroupKey: 'a', relevanceScore: 1 }), item('b', 'S 202', { billGroupKey: 'a', relevanceScore: 8 })] })
    expect(text(html)).toContain('11 new matches')
    expect(html).toMatch(/>RI S 202</)
    expect(text(html)).toContain('See all 11 new matches')
  })

  it('keeps the headline and contents box at one when updates and a new-match group share a digest', () => {
    const html = render([ev({ billId: 'u1', billNumber: 'H 404' })], { newMatches: pair })
    expect(text(html)).toContain('1 new match')
    expect(text(html)).not.toContain('2 new matches')
  })

  it('leaves an ungrouped new match as it was', () => {
    const html = render([], { newMatches: [item('c', 'H 303')] })
    expect(cards(html)).toBe(1)
    expect(text(html)).toContain('1 new match in')
  })
})
