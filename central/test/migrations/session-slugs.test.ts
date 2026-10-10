import { env, applyD1Migrations } from 'cloudflare:test'
import { describe, it, expect, beforeEach } from 'vitest'
import { drizzle } from 'drizzle-orm/d1'
import * as schema from '../../src/db/schema'
import { legiscanMigrations, parseMigrations, setupDb, type MigrationFiles } from '../helpers/migrations'
import { assignSessionSlugs } from '../../src/lib/sessionSlugs'
import { loadStateOwners } from '../../src/lib/stateProviders'
import { app } from '../../src/index-legiscan'

// A central upgrading onto session slugs: built from the migrations before
// 0031, holding sessions whose names ask for the same slug, then migrated and
// given its first cron tick. Checked through the bill and session routes.

const before0031: MigrationFiles = Object.fromEntries(
  Object.entries(legiscanMigrations).filter(([path]) => path.split('/').pop()! < '0031'))

const SECRET = 'test-secret'
const get = async (path: string) => {
  const res = await app.fetch(new Request(`http://central/api${path}`, { headers: { 'x-admin-secret': SECRET } }), { ...(env as any), ADMIN_SECRET: SECRET })
  expect(res.status).toBe(200)
  return res.json() as Promise<any>
}
const slugsIn = async (state: string) =>
  Object.fromEntries((await get(`/bills/sessions?state=${state}`)).sessions.map((s: any) => [s.sessionId, s.slug]))

// A session id, its state, its provider, and its name.
const SESSIONS: [number, string, string, string][] = [
  // Two providers' Maryland 2026 regular sessions, and an MGA special session.
  [2200, 'MD', 'legiscan', '2026 Regular Session'],
  [3000000005, 'MD', 'mga', '2026 Regular Session'],
  [3000000006, 'MD', 'mga', '2026 Special Session 1'],
  // Another state's 2026 session asks for the same slug, which is fine.
  [2154, 'RI', 'legiscan', '2026 Regular Session'],
  // A Council Period has its own slug, apart from DC's other 2025-2026 sessions.
  [1000000026, 'DC', 'lims', '2025-2026 Council Period 26'],
  [2100, 'DC', 'legiscan', '2025-2026 Regular Session'],
  // Names with no year: the slug a third one asks for, and its "-2", are taken.
  [7001, 'US', 'legiscan', 'Special Joint Session'],
  [7002, 'US', 'legiscan', 'Special Joint Session 2'],
  [7003, 'US', 'legiscan', 'Special Joint Session'],
]

beforeEach(async () => {
  await setupDb(before0031)
  await env.DB.batch(SESSIONS.map(([id, state, provider, name]) => env.DB.prepare(
    `INSERT INTO sessions (session_id, state_id, state, year_start, year_end, session_tag, session_title, session_name, provider)
     VALUES (?, 1, ?, 2026, 2026, '', ?, ?, ?)`).bind(id, state, name, name, provider)))
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO bills (bill_id, change_hash, session_id, state, state_id, bill_number, title, provider)
      VALUES (9001, 'h', 2200, 'MD', 20, 'HB1', 'LegiScan HB 1', 'legiscan'), (3000000101, 'h', 3000000005, 'MD', 20, 'HB1', 'MGA HB 1', 'mga')`),
  ])
  await applyD1Migrations(env.DB, parseMigrations(legiscanMigrations))
})

describe('session slugs on an upgraded central', () => {
  it('migrate colliding sessions without failing, then give each a slug unique within its state', async () => {
    // The migration only adds the column: every session is waiting for a slug.
    expect(Object.values(await slugsIn('MD'))).toEqual([null, null, null])

    await assignSessionSlugs(drizzle(env.DB, { schema }))

    // The lowest id keeps the plain slug, so LegiScan's URLs mean what they meant.
    expect(await slugsIn('MD')).toEqual({ 2200: '2026', 3000000005: '2026-2', 3000000006: '2026-s1' })
    expect(await slugsIn('RI')).toEqual({ 2154: '2026' })
    expect(await slugsIn('DC')).toEqual({ 1000000026: 'cp26', 2100: '2025-2026' })
    expect(await slugsIn('US')).toEqual({ 7001: 'special-joint-session', 7002: 'special-joint-session-2', 7003: 'special-joint-session-3' })
  })

  it('send each bill its own session slug, so same-number bills in same-name sessions resolve apart', async () => {
    await assignSessionSlugs(drizzle(env.DB, { schema }))
    expect(await get('/bills/legiscan:9001')).toMatchObject({ number: 'HB1', sessionName: '2026 Regular Session', sessionSlug: '2026' })
    expect(await get('/bills/legiscan:3000000101')).toMatchObject({ number: 'HB1', sessionName: '2026 Regular Session', sessionSlug: '2026-2' })
  })

  it('never change a slug once assigned, and slug a session written later', async () => {
    const db = drizzle(env.DB, { schema })
    await assignSessionSlugs(db)
    // Another 2026 session arrives (as a seed script writes one, with no slug).
    await env.DB.prepare(`INSERT INTO sessions (session_id, state_id, state, year_start, year_end, session_title, session_name)
      VALUES (2199, 20, 'MD', 2026, 2026, '2026 Regular Session', '2026 Regular Session')`).run()
    await assignSessionSlugs(db)
    await assignSessionSlugs(db)
    expect(await slugsIn('MD')).toEqual({ 2199: '2026-3', 2200: '2026', 3000000005: '2026-2', 3000000006: '2026-s1' })
  })

  it('give every session one slug when several jobs assign at once', async () => {
    const db = drizzle(env.DB, { schema })
    await Promise.all([assignSessionSlugs(db), assignSessionSlugs(db), assignSessionSlugs(db)])
    expect(await slugsIn('MD')).toEqual({ 2200: '2026', 3000000005: '2026-2', 3000000006: '2026-s1' })
    expect(await slugsIn('US')).toEqual({ 7001: 'special-joint-session', 7002: 'special-joint-session-2', 7003: 'special-joint-session-3' })
  })

  it('give the plain slug to the session of the provider that owns the state, ahead of an older one', async () => {
    // A fork's DC: LIMS owns it, and a leftover LegiScan Council Period 26
    // session has a lower id. /DC/cp26/... stays with LIMS.
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO sessions (session_id, state_id, state, year_start, year_end, session_title, session_name, provider)
        VALUES (2050, 9, 'DC', 2025, 2026, '2025-2026 Council Period 26', '2025-2026 Council Period 26', 'legiscan')`),
      env.DB.prepare(`INSERT INTO state_providers (state, provider) VALUES ('DC', 'lims')`),
    ])
    await assignSessionSlugs(drizzle(env.DB, { schema }))
    expect(await slugsIn('DC')).toEqual({ 1000000026: 'cp26', 2050: 'cp26-2', 2100: '2025-2026' })
    // Maryland has no row, so LegiScan owns it, as before.
    expect(await slugsIn('MD')).toEqual({ 2200: '2026', 3000000005: '2026-2', 3000000006: '2026-s1' })
  })

  it('seed ownership from the old env var before the first slugs, as the cron tick does', async () => {
    await env.DB.prepare(`INSERT INTO sessions (session_id, state_id, state, year_start, year_end, session_title, session_name, provider)
      VALUES (2050, 9, 'DC', 2025, 2026, '2025-2026 Council Period 26', '2025-2026 Council Period 26', 'legiscan')`).run()
    const db = drizzle(env.DB, { schema })
    await loadStateOwners({ ...(env as any), LIMS_STATES: 'DC', LIMS_API_KEY: 'k' }, db)
    await assignSessionSlugs(db)
    expect(await slugsIn('DC')).toEqual({ 1000000026: 'cp26', 2050: 'cp26-2', 2100: '2025-2026' })
  })

  it('refuse a second session with a slug its state already has', async () => {
    await assignSessionSlugs(drizzle(env.DB, { schema }))
    await expect(env.DB.prepare(`UPDATE sessions SET slug = '2026' WHERE session_id = 3000000005`).run()).rejects.toThrow(/UNIQUE/)
  })
})
