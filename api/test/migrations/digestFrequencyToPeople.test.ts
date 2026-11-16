import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { resetDb, applyMigrations } from '../helpers'

// Migration 0130. How often the email digest comes moves from the team (the email-digest module's `frequency` and
// `weeklyDay`) to each person (users.email_digest_weekly_day: null for every morning, or a weekday 0 to 6). Everyone
// starts at every morning, except on a team whose digest is weekly today, where everyone starts weekly on the team's
// day, so nobody's digest changes. That day's weekly window carries on from the team's last digest.

const config = async (key: string) =>
  (await env.DB.prepare('SELECT value FROM association_config WHERE key = ?').bind(key).first<{ value: string }>())?.value
const days = async () =>
  (await env.DB.prepare('SELECT id, email_digest_weekly_day AS d FROM users ORDER BY id').all<{ id: string; d: number | null }>()).results.map(r => [r.id, r.d])
const weeklyKeys = async () =>
  (await env.DB.prepare("SELECT key FROM association_config WHERE key LIKE 'last_weekly_digest_at%' ORDER BY key").all<{ key: string }>()).results.map(r => r.key)

describe('migration 0130_digest_frequency_per_person', () => {
  beforeEach(async () => {
    await resetDb()
    await applyMigrations({ before: '0130' })
    for (const [id, role] of [['a', 'admin'], ['m', 'member'], ['o', 'owner']]) {
      await env.DB.prepare('INSERT INTO users (id, email, name, role) VALUES (?, ?, ?, ?)').bind(id, `${id}@example.com`, id, role).run()
    }
  })
  const saveModules = (value: unknown) =>
    env.DB.prepare("INSERT INTO association_config (key, value) VALUES ('modules', ?)").bind(JSON.stringify(value)).run()
  const saveLastDigest = (value: string) =>
    env.DB.prepare("INSERT INTO association_config (key, value) VALUES ('last_digest_at', ?)").bind(value).run()

  it("makes everyone weekly on the team's day on a weekly team, and carries on that day's window", async () => {
    await saveModules({ 'email-digest': { enabled: true, settings: { frequency: 'weekly', weeklyDay: '5' } } })
    await saveLastDigest('2026-11-06 11:00:20')

    await applyMigrations()

    expect(await days()).toEqual([['a', 5], ['m', 5], ['o', 5]])
    expect(await weeklyKeys()).toEqual(['last_weekly_digest_at_5'])
    expect(await config('last_weekly_digest_at_5')).toBe('2026-11-06 11:00:20')
  })

  it('uses Monday for a weekly team that saved no day, as the digest did', async () => {
    await saveModules({ 'email-digest': { enabled: true, settings: { frequency: 'weekly' } } })

    await applyMigrations()

    expect(await days()).toEqual([['a', 1], ['m', 1], ['o', 1]])
  })

  it('makes everyone weekly on a weekly team whose digest is off, so turning it back on changes nothing', async () => {
    await saveModules({ 'email-digest': { enabled: false, settings: { frequency: 'weekly', weeklyDay: '0' } } })

    await applyMigrations()

    expect(await days()).toEqual([['a', 0], ['m', 0], ['o', 0]])
  })

  it('leaves everyone at every morning on a daily team, with no saved how often, or with no saved modules', async () => {
    for (const modules of [{ 'email-digest': { enabled: true, settings: { frequency: 'daily', weeklyDay: '3' } } }, { 'email-digest': true }, null]) {
      await resetDb()
      await applyMigrations({ before: '0130' })
      await env.DB.prepare("INSERT INTO users (id, email, name, role) VALUES ('m', 'm@example.com', 'm', 'member')").run()
      if (modules) await saveModules(modules)
      await saveLastDigest('2026-11-12 11:00:20')

      await applyMigrations()

      expect(await days()).toEqual([['m', null]])
      expect(await weeklyKeys()).toEqual([])
    }
  })

  it('starts a person added later at every morning', async () => {
    await saveModules({ 'email-digest': { enabled: true, settings: { frequency: 'weekly', weeklyDay: '2' } } })
    await applyMigrations()
    await env.DB.prepare("INSERT INTO users (id, email, name, role) VALUES ('z', 'z@example.com', 'z', 'member')").run()

    expect((await days()).find(([id]) => id === 'z')).toEqual(['z', null])
  })
})
