import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { env } from 'cloudflare:test'
import { resetDb, applyMigrations, seedUser, seedSession, seedBill } from '../helpers'
import { getDb } from '../../src/db/client'
import { feedEvents, associationConfig } from '../../src/db/schema'
import { runDigest } from '../../src/lib/digest'

// #366: members get the same new-match section admins get, under a nested
// option on their digest switch ("Include newly matched bills", on by default).
// Seam: the digest job, with outgoing email captured.

let emails: any[]
const to = (addr: string) => emails.filter(e => e.to[0] === addr)
const recent = () => new Date(Date.now() - 3600_000).toISOString().slice(0, 19).replace('T', ' ')

async function member(email: string, opts: { matches?: boolean; digest?: boolean } = {}) {
  const id = await seedUser({
    email, role: 'member',
    emailDigestEnabled: opts.digest !== false,
    emailDigestMatchesEnabled: opts.matches !== false,
  })
  await seedSession(id)
}

const routine = (billNumber: string, relevanceScore = 70) =>
  seedBill({ billNumber, state: 'RI', session: '2026', matchType: 'keyword', matchProvenance: 'routine', newMatchAt: recent(), relevanceScore })

async function priorityUpdate(billNumber: string) {
  const billId = await seedBill({ billNumber, state: 'RI', session: '2026', priority: 'high' })
  await getDb(env.DB).insert(feedEvents).values({ id: crypto.randomUUID(), type: 'position_set' as any, billId, userId: 'system', metadata: JSON.stringify({ position: 'Support' }) })
}

beforeEach(async () => {
  await resetDb(); await applyMigrations()
  emails = []
  vi.stubGlobal('fetch', vi.fn(async (_u: string, init: any) => { emails.push(JSON.parse(init.body)); return new Response('{}', { status: 200 }) }))
  const db = getDb(env.DB)
  await db.insert(associationConfig).values({ key: 'modules', value: JSON.stringify({ 'email-digest': true }) })
})
afterEach(() => { vi.unstubAllGlobals() })

describe("members' digests: new matches", () => {
  it('gives a member with the option on the same capped section an admin gets, and one with it off none', async () => {
    const admin = await seedUser({ email: 'admin@e.com', role: 'admin' }); await seedSession(admin)
    await member('on@e.com'); await member('off@e.com', { matches: false })
    for (let i = 1; i <= 12; i++) await routine(`NM ${100 + i}`, 50 + i)
    await priorityUpdate('PRI 1')

    await runDigest(env as any, getDb(env.DB))

    const adminHtml = to('admin@e.com')[0].html as string
    const onHtml = to('on@e.com')[0].html as string
    expect(onHtml).toContain('12 new matches')
    expect(onHtml).toContain('NM 112')
    expect(onHtml).not.toContain('NM 101')
    expect(onHtml).toContain('See all 12 new matches')
    // Same list in the same order as the admin's. Counts each card's badge, not
    // every mention: an admin's cards also link to the bill from "Set priority".
    const listed = (html: string) => [...html.matchAll(/>[^<>]*?(NM \d+)</g)].map(m => m[1])
    expect(listed(onHtml)).toEqual(listed(adminHtml))
    expect(listed(onHtml).length).toBeGreaterThanOrEqual(10)
    expect(adminHtml.match(/>Set priority</g)).toHaveLength(10)
    expect(onHtml).not.toContain('>Set priority<')
    // The member with it off still gets the updates, and nothing else.
    expect(to('off@e.com')).toHaveLength(1)
    expect(to('off@e.com')[0].html).toContain('PRI 1')
    expect(to('off@e.com')[0].html).not.toContain('new match')
  })

  it('sends a member with the option on a digest for a window with only new matches, and one with it off nothing', async () => {
    await member('on@e.com'); await member('off@e.com', { matches: false })
    await routine('NM 7')

    const result = await runDigest(env as any, getDb(env.DB))

    expect(to('on@e.com')).toHaveLength(1)
    expect(to('on@e.com')[0].html).toContain('NM 7')
    expect(to('on@e.com')[0].subject).toBe('Your daily digest: 1 new match')
    expect(to('off@e.com')).toHaveLength(0)
    expect(result).toEqual({ ok: true, recipients: 1, sent: 1, failed: 0 })
  })

  it('leads a member with the option on with updates, with the section after them', async () => {
    await member('on@e.com')
    await routine('NM 8')
    await priorityUpdate('PRI 2')

    await runDigest(env as any, getDb(env.DB))

    const html = to('on@e.com')[0].html as string
    expect(html).toContain('PRI 2')
    expect(html.indexOf('PRI 2')).toBeLessThan(html.indexOf('id="digest-new-matches"'))
    expect(to('on@e.com')[0].subject).toBe('Your daily digest: 1 updated bill, 1 new match')
  })

  it("never lists a bulk match, one with no declaration, or one under the minimum relevance in a member's digest", async () => {
    await member('on@e.com')
    await getDb(env.DB).insert(associationConfig).values({ key: 'new_match_min_relevance', value: '6' })
    await seedBill({ billNumber: 'BULK 1', matchType: 'keyword', matchProvenance: 'bulk', newMatchAt: recent(), relevanceScore: 9 })
    await seedBill({ billNumber: 'NONE 1', matchType: 'keyword', matchProvenance: null, newMatchAt: recent(), relevanceScore: 9 })
    await seedBill({ billNumber: 'LOW 1', matchType: 'keyword', matchProvenance: 'routine', newMatchAt: recent(), relevanceScore: 3 })
    await routine('HI 1', 8)

    await runDigest(env as any, getDb(env.DB))

    expect(to('on@e.com')).toHaveLength(1)
    const html = to('on@e.com')[0].html as string
    expect(html).toContain('1 new match')
    expect(html).toContain('HI 1')
    for (const n of ['BULK 1', 'NONE 1', 'LOW 1']) expect(html).not.toContain(n)
  })

  it('sends a member nothing for a window with only bulk matches, even with the option on', async () => {
    await member('on@e.com')
    await seedBill({ billNumber: 'BULK 2', matchType: 'keyword', matchProvenance: 'bulk', newMatchAt: recent(), relevanceScore: 9 })

    await runDigest(env as any, getDb(env.DB))

    expect(emails).toHaveLength(0)
  })

  it('sends a member who turned the digest off nothing, whatever the option says', async () => {
    await member('quiet@e.com', { digest: false, matches: true })
    await member('on@e.com')
    await routine('NM 9')

    await runDigest(env as any, getDb(env.DB))

    expect(to('quiet@e.com')).toHaveLength(0)
    expect(to('on@e.com')).toHaveLength(1)
  })

  it('leaves an admin unaffected by the option: admins always get the section', async () => {
    const admin = await seedUser({ email: 'admin@e.com', role: 'admin', emailDigestMatchesEnabled: false }); await seedSession(admin)
    await routine('NM 10')

    await runDigest(env as any, getDb(env.DB))

    expect(to('admin@e.com')).toHaveLength(1)
    expect(to('admin@e.com')[0].html).toContain('NM 10')
  })
})
