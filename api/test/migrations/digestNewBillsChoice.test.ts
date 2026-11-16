import { describe, it, expect, beforeEach, vi } from 'vitest'
import { env } from 'cloudflare:test'
import { resetDb, applyMigrations, seedSession, seedBill } from '../helpers'
import { getDb } from '../../src/db/client'
import { associationConfig, feedEvents } from '../../src/db/schema'
import { runDigest } from '../../src/lib/digest'
import { mail, resetMail } from '../mail'

// Migration 0128 (#1036). A person's "Newly found bills" choice gains an unset state, so a member can follow the
// team's default. users.email_digest_matches_enabled is NOT NULL, so the choice moves to a new nullable column,
// users.email_digest_new_bills: 1 on, 0 off, and NULL unset (the team's default for a member, on for an admin or
// owner). The migration keeps every off as off and makes every other value unset. The default starts on, so nobody's
// email changes. The old column stays as it was, for the build that is still serving while the deploy runs.

vi.mock('../../src/lib/email', async (importOriginal) =>
  (await import('../mail')).withFakeSender(await importOriginal<typeof import('../../src/lib/email')>()))

type Role = 'admin' | 'member' | 'owner'
const PEOPLE: Array<[id: string, role: Role, matches: 0 | 1]> = [
  ['member-off', 'member', 0],
  ['member-on', 'member', 1],
  ['admin-on', 'admin', 1],
  ['admin-off', 'admin', 0],
  ['owner-on', 'owner', 1],
]
const email = (id: string) => `${id}@example.com`

describe('migration 0128_digest_new_bills_choice', () => {
  beforeEach(async () => {
    await resetDb()
    resetMail()
    mail.sendBatch.mockResolvedValue({ sent: 1, failed: 0, skipped: 0, results: [] })
    // The database as it stands before the migration, with each person's switch as 0127 left it.
    await applyMigrations({ before: '0128' })
    for (const [id, role, matches] of PEOPLE) {
      await env.DB.prepare('INSERT INTO users (id, email, name, role, email_digest_matches_enabled) VALUES (?, ?, ?, ?, ?)')
        .bind(id, email(id), id, role, matches).run()
    }
  })

  const all = async () => (await env.DB.prepare('SELECT * FROM users ORDER BY id').all<Record<string, unknown>>()).results

  it('keeps a member at off off, and makes a member at on and an admin at on unset', async () => {
    await applyMigrations()

    const choice = Object.fromEntries((await all()).map(r => [r.id, r.email_digest_new_bills]))
    expect(choice['member-off']).toBe(0)
    expect(choice['member-on']).toBeNull()
    expect(choice['admin-on']).toBeNull()
  })

  it('keeps every off as off and makes every on unset, whatever the role', async () => {
    await applyMigrations()

    expect((await all()).map(r => [r.id, r.email_digest_new_bills])).toEqual([
      ['admin-off', 0], ['admin-on', null], ['member-off', 0], ['member-on', null], ['owner-on', null],
    ])
  })

  it('leaves the old switch as it was, so the build still serving during the deploy reads what it read', async () => {
    await applyMigrations()

    expect((await all()).map(r => [r.id, r.email_digest_matches_enabled])).toEqual([
      ['admin-off', 0], ['admin-on', 1], ['member-off', 0], ['member-on', 1], ['owner-on', 1],
    ])
  })

  it('starts a person added after it unset', async () => {
    await applyMigrations()
    await env.DB.prepare("INSERT INTO users (id, email, name, role) VALUES ('new-member', 'new-member@example.com', 'N', 'member')").run()

    expect((await all()).find(r => r.id === 'new-member')?.email_digest_new_bills).toBeNull()
  })

  it('sends all three the same parts as before: the member at off gets no newly found part, the member and the admin at on get it', async () => {
    for (const [id] of PEOPLE) await seedSession(id)
    await getDb(env.DB).insert(associationConfig).values({ key: 'modules', value: JSON.stringify({ 'email-digest': true }) })
    const pri = await seedBill({ billNumber: 'P 1', state: 'UT', session: '2026', priority: 'high' })
    await getDb(env.DB).insert(feedEvents).values({ id: crypto.randomUUID(), type: 'position_set' as never, billId: pri, userId: 'system', metadata: JSON.stringify({ position: 'Support' }) })
    await seedBill({ billNumber: 'NM 7', state: 'UT', session: '2026', matchType: 'keyword', matchProvenance: 'routine', relevanceScore: 7, newMatchAt: new Date(Date.now() - 3600_000).toISOString().slice(0, 19).replace('T', ' ') })

    await applyMigrations()
    await runDigest(env as never, getDb(env.DB))

    const sent = mail.sent() as Array<{ to: string[]; subject: string }>
    const subject = (id: string) => sent.filter(s => s.to[0] === email(id)).map(s => s.subject)
    // Before this migration, each person got the newly found part when their switch was on.
    expect(subject('member-off')).toEqual(['Your daily digest: 1 updated bill'])
    expect(subject('member-on')).toEqual(['Your daily digest: 1 updated bill, 1 new match'])
    expect(subject('admin-on')).toEqual(['Your daily digest: 1 updated bill, 1 new match'])
    expect(subject('admin-off')).toEqual(['Your daily digest: 1 updated bill'])
    expect(subject('owner-on')).toEqual(['Your daily digest: 1 updated bill, 1 new match'])
  })
})
