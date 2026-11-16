import { describe, it, expect, beforeEach, vi } from 'vitest'
import { env } from 'cloudflare:test'
import { resetDb, applyMigrations, seedUser, seedSession, seedBill } from '../helpers'
import { getDb } from '../../src/db/client'
import { associationConfig, feedEvents } from '../../src/db/schema'
import { runDigest } from '../../src/lib/digest'
import { mail, resetMail } from '../mail'

// Migration 0127 (#1035). Newly found bills in the digest now depend only on a person's new-match switch
// (users.email_digest_matches_enabled), for every role, and no longer on the priority switch
// (users.email_digest_enabled). Before, runDigest mailed only people whose priority switch was on, and gave an admin
// or owner the new-match section whatever the new-match switch said. The migration sets each person's new-match
// switch to whether they get the section today, so nobody's newly found bills change. A person with the digest
// switch off who follows a view starts getting that view, as #1035 intends.

vi.mock('../../src/lib/email', async (importOriginal) =>
  (await import('../mail')).withFakeSender(await importOriginal<typeof import('../../src/lib/email')>()))

type Role = 'admin' | 'member' | 'owner'
const ROLES: Role[] = ['admin', 'member', 'owner']
const BOOLS = [0, 1] as const

const key = (role: Role, digest: number, matches: number) => `${role}-d${digest}-m${matches}`
const email = (role: Role, digest: number, matches: number) => `${key(role, digest, matches)}@example.com`

describe('migration 0127_digest_new_found_backfill', () => {
  beforeEach(async () => {
    await resetDb()
    resetMail()
    mail.sendBatch.mockResolvedValue({ sent: 1, failed: 0, skipped: 0, results: [] })
    // The database as it stands before the backfill.
    await applyMigrations({ before: '0127' })
  })

  const insert = (role: Role, digest: number, matches: number) =>
    env.DB.prepare('INSERT INTO users (id, email, name, role, email_digest_enabled, email_digest_matches_enabled) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(key(role, digest, matches), email(role, digest, matches), key(role, digest, matches), role, digest, matches).run()
  const matchesSwitch = async () => Object.fromEntries(
    (await env.DB.prepare('SELECT id, email_digest_matches_enabled AS m FROM users').all<{ id: string; m: number }>()).results.map(r => [r.id, r.m]))
  const seedEveryCombination = async () => {
    for (const role of ROLES) for (const d of BOOLS) for (const m of BOOLS) await insert(role, d, m)
  }

  it('sets the new-match switch of every role, priority switch, and prior value to whether that person got the section', async () => {
    await seedEveryCombination()

    await applyMigrations()

    const after = await matchesSwitch()
    for (const role of ROLES) for (const d of BOOLS) for (const m of BOOLS) {
      const isAdmin = role !== 'member'
      // Off with the priority switch off. On for an admin or owner with it on. A member with it on keeps their own value.
      const expected = d === 0 ? 0 : isAdmin ? 1 : m
      expect(after[key(role, d, m)], key(role, d, m)).toBe(expected)
    }
  })

  it('leaves the priority switch, the role, and the view subscriptions as they were', async () => {
    await seedEveryCombination()
    await env.DB.prepare('INSERT INTO saved_views (id, name, query, slug, created_by, display_order) VALUES (?, ?, ?, ?, ?, 0)')
      .bind('v1', 'Roads', 'state=RI', 'roads', key('admin', 1, 1)).run()
    await env.DB.prepare('INSERT INTO saved_view_subscriptions (user_id, view_id) VALUES (?, ?)').bind(key('member', 0, 0), 'v1').run()

    await applyMigrations()

    const rows = (await env.DB.prepare('SELECT id, role, email_digest_enabled AS d FROM users ORDER BY id').all<{ id: string; role: string; d: number }>()).results
    for (const r of rows) expect(r).toEqual({ id: r.id, role: r.id.split('-')[0], d: Number(r.id.split('-d')[1][0]) })
    expect((await env.DB.prepare('SELECT user_id, view_id FROM saved_view_subscriptions').all()).results)
      .toEqual([{ user_id: key('member', 0, 0), view_id: 'v1' }])
  })

  it('leaves everyone with the same digest as before: the same people get the same parts', async () => {
    await seedEveryCombination()
    // Every person has a session, so each is a recipient. One priority bill with news, and one routine new match.
    for (const role of ROLES) for (const d of BOOLS) for (const m of BOOLS) await seedSession(key(role, d, m))
    await getDb(env.DB).insert(associationConfig).values({ key: 'modules', value: JSON.stringify({ 'email-digest': true }) })
    const pri = await seedBill({ billNumber: 'P 1', state: 'UT', session: '2026', priority: 'high' })
    await getDb(env.DB).insert(feedEvents).values({ id: crypto.randomUUID(), type: 'position_set' as never, billId: pri, userId: 'system', metadata: JSON.stringify({ position: 'Support' }) })
    await seedBill({ billNumber: 'NM 7', state: 'UT', session: '2026', matchType: 'keyword', matchProvenance: 'routine', relevanceScore: 7, newMatchAt: new Date(Date.now() - 3600_000).toISOString().slice(0, 19).replace('T', ' ') })

    await applyMigrations()
    await runDigest(env as never, getDb(env.DB))

    const sent = mail.sent() as Array<{ to: string[]; subject: string; html: string }>
    // Before this change: only people with the priority switch on got an email. An admin or owner got the
    // new-match section whatever their switch said, and a member got it when theirs was on.
    const expectedSubject = (role: Role, d: number, m: number) =>
      d === 0 ? null : (role !== 'member' || m === 1) ? 'Your daily digest: 1 updated bill, 1 new match' : 'Your daily digest: 1 updated bill'
    for (const role of ROLES) for (const d of BOOLS) for (const m of BOOLS) {
      const got = sent.filter(s => s.to[0] === email(role, d, m))
      const subject = expectedSubject(role, d, m)
      if (subject === null) expect(got, key(role, d, m)).toHaveLength(0)
      else {
        expect(got, key(role, d, m)).toHaveLength(1)
        expect(got[0].subject, key(role, d, m)).toBe(subject)
      }
    }
    // Three roles, two new-match values, with the priority switch on: nobody else got one.
    expect(sent).toHaveLength(6)
  })
})
