import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { resetDb, applyMigrations } from '../helpers'

// Migration 0127. How each email is chosen moves to each person (floorvote/floorvote#1033). The admin keeps one switch
// (notification_emails_enabled) and the week ahead day. The team's digest and week ahead modules turn into each person's
// own switches, so nobody's email changes.

const config = async (key: string) =>
  (await env.DB.prepare('SELECT value FROM association_config WHERE key = ?').bind(key).first<{ value: string }>())?.value
const configKeys = async () =>
  (await env.DB.prepare('SELECT key FROM association_config ORDER BY key').all<{ key: string }>()).results.map(r => r.key)
const people = async () =>
  (await env.DB.prepare(
    'SELECT id, email_digest_enabled AS digest, email_digest_matches_enabled AS matches, email_week_ahead_enabled AS ahead, email_digest_weekly_day AS day FROM users ORDER BY id',
  ).all<{ id: string; digest: number; matches: number; ahead: number; day: number | null }>()).results
const subscriptions = async () => (await env.DB.prepare('SELECT COUNT(*) AS n FROM saved_view_subscriptions').first<{ n: number }>())!.n

const modules = (digest: unknown, weekAhead: unknown) => ({
  ...(digest === undefined ? {} : { 'email-digest': digest }),
  ...(weekAhead === undefined ? {} : { 'week-ahead': weekAhead }),
  'waiting-for-vote': true,
})
const daily = { enabled: true, settings: { frequency: 'daily', weeklyDay: '1' } }
const weekAheadOn = { enabled: true, settings: { weeklyDay: '3' } }

describe('migration 0127_notification_settings_per_person', () => {
  beforeEach(async () => {
    await resetDb()
    await applyMigrations({ before: '0127' })
  })
  const addUser = (id: string, role: string, cols: { digest?: number; matches?: number } = {}) =>
    env.DB.prepare('INSERT INTO users (id, email, name, role, email_digest_enabled, email_digest_matches_enabled) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(id, `${id}@example.com`, id, role, cols.digest ?? 1, cols.matches ?? 1).run()
  const saveConfig = (key: string, value: string) =>
    env.DB.prepare('INSERT INTO association_config (key, value) VALUES (?, ?)').bind(key, value).run()
  const saveModules = (value: unknown) => saveConfig('modules', typeof value === 'string' ? value : JSON.stringify(value))

  it('keeps everyone with the digest and week ahead on, moves the day, and drops the old module entries', async () => {
    await saveModules(modules(daily, weekAheadOn))
    await addUser('a', 'admin', { matches: 0 })
    await addUser('m1', 'member', { matches: 1 })
    await addUser('m2', 'member', { matches: 0 })
    await addUser('m3', 'member', { digest: 0 })

    await applyMigrations()

    expect(await people()).toEqual([
      { id: 'a', digest: 1, matches: 1, ahead: 1, day: null },
      { id: 'm1', digest: 1, matches: 1, ahead: 1, day: null },
      { id: 'm2', digest: 1, matches: 0, ahead: 1, day: null },
      { id: 'm3', digest: 0, matches: 0, ahead: 1, day: null },
    ])
    expect(await config('week_ahead_day')).toBe('3')
    expect(JSON.parse((await config('modules'))!)).toEqual({ 'waiting-for-vote': true })
    expect(await config('digest_weekly_day_for_new_people')).toBeUndefined()
  })

  it('turns off both digest parts and removes followed views where the digest module is off', async () => {
    await saveModules(modules({ enabled: false, settings: { frequency: 'daily' } }, weekAheadOn))
    await addUser('a', 'admin')
    await addUser('m', 'member')
    await env.DB.prepare("INSERT INTO saved_views (id, name, query) VALUES ('v1', 'View', 'q=x')").run()
    await env.DB.prepare("INSERT INTO saved_view_subscriptions (user_id, view_id) VALUES ('a', 'v1'), ('m', 'v1')").run()

    await applyMigrations()

    expect(await people()).toEqual([
      { id: 'a', digest: 0, matches: 0, ahead: 1, day: null },
      { id: 'm', digest: 0, matches: 0, ahead: 1, day: null },
    ])
    expect(await subscriptions()).toBe(0)
  })

  // On upstream a person with their own digest switch off got no digest at all, followed views included. A followed view
  // is sent on its own now, so their follows go, or they'd start getting views they didn't get before.
  it("removes the followed views of a person whose own digest switch was off, and keeps everyone else's", async () => {
    await saveModules(modules(daily, weekAheadOn))
    await addUser('off', 'member', { digest: 0 })
    await addUser('on', 'member')
    await env.DB.prepare("INSERT INTO saved_views (id, name, query) VALUES ('v1', 'View', 'q=x')").run()
    await env.DB.prepare("INSERT INTO saved_view_subscriptions (user_id, view_id) VALUES ('off', 'v1'), ('on', 'v1')").run()

    await applyMigrations()

    const followers = (await env.DB.prepare('SELECT user_id FROM saved_view_subscriptions ORDER BY user_id').all<{ user_id: string }>()).results.map(r => r.user_id)
    expect(followers).toEqual(['on'])
  })

  it('reads a missing modules row as both emails off, with Monday as the week ahead day', async () => {
    await addUser('a', 'admin')
    await addUser('m', 'member')

    await applyMigrations()

    expect(await people()).toEqual([
      { id: 'a', digest: 0, matches: 0, ahead: 0, day: null },
      { id: 'm', digest: 0, matches: 0, ahead: 0, day: null },
    ])
    expect(await config('week_ahead_day')).toBe('1')
  })

  it('reads the legacy boolean email-digest as on', async () => {
    await saveModules(modules(true, true))
    await addUser('a', 'admin')
    await addUser('m', 'member')

    await applyMigrations()

    expect(await people()).toEqual([
      { id: 'a', digest: 1, matches: 1, ahead: 1, day: null },
      { id: 'm', digest: 1, matches: 1, ahead: 1, day: null },
    ])
    expect(await config('week_ahead_day')).toBe('1')
  })

  it('turns off the week ahead for everyone when the week ahead module is missing', async () => {
    await saveModules(modules(daily, undefined))
    await addUser('a', 'admin')
    await addUser('m', 'member')

    await applyMigrations()

    expect((await people()).map(p => [p.id, p.digest, p.ahead])).toEqual([['a', 1, 0], ['m', 1, 0]])
    expect(await config('week_ahead_day')).toBe('1')
  })

  it('makes everyone weekly on the weekly team day, carries that window on, and seeds new people', async () => {
    await saveModules(modules({ enabled: true, settings: { frequency: 'weekly', weeklyDay: '5' } }, weekAheadOn))
    await saveConfig('last_digest_at', '2026-11-06 11:00:20')
    await addUser('a', 'admin')
    await addUser('m', 'member')

    await applyMigrations()

    expect((await people()).map(p => [p.id, p.day])).toEqual([['a', 5], ['m', 5]])
    expect(await config('last_weekly_digest_at_5')).toBe('2026-11-06 11:00:20')
    expect(await config('digest_weekly_day_for_new_people')).toBe('5')
  })

  it('uses Monday for a weekly team that saved no day', async () => {
    await saveModules(modules({ enabled: true, settings: { frequency: 'weekly' } }, weekAheadOn))
    await addUser('a', 'admin')

    await applyMigrations()

    expect((await people()).map(p => p.day)).toEqual([1])
    expect(await config('digest_weekly_day_for_new_people')).toBe('1')
  })

  it.each(['true', 'false'])('removes a saved mention_emails_enabled of %s and writes no notification_emails_enabled', async (saved) => {
    await saveModules(modules(daily, weekAheadOn))
    await saveConfig('mention_emails_enabled', saved)
    await addUser('a', 'admin')

    await applyMigrations()

    expect(await config('mention_emails_enabled')).toBeUndefined()
    expect(await config('notification_emails_enabled')).toBeUndefined()
  })

  it('writes nothing on an empty database', async () => {
    const before = await configKeys()

    await applyMigrations()

    expect(await configKeys()).toEqual(before)
    expect(await config('week_ahead_day')).toBeUndefined()
  })

  it('reads malformed modules JSON as both off and leaves the row as it was', async () => {
    await saveModules('not json')
    await addUser('a', 'admin')
    await addUser('m', 'member')

    await applyMigrations()

    expect(await people()).toEqual([
      { id: 'a', digest: 0, matches: 0, ahead: 0, day: null },
      { id: 'm', digest: 0, matches: 0, ahead: 0, day: null },
    ])
    expect(await config('modules')).toBe('not json')
  })
})
