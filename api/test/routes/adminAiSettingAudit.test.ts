import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { env } from 'cloudflare:test'
import { app } from '../../src/index'
import { resetDb, applyMigrations, seedUser, seedSession } from '../helpers'
import { getDb } from '../../src/db/client'
import { associationConfig } from '../../src/db/schema'

// Who changed each AI setting, and when (#602). The same record #570 keeps for
// the claim links setting, for ai_context, relevance_question, and tag_taxonomy.

vi.mock('../../src/lib/centralFetch', () => ({
  centralFetch: vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }),
}))
vi.mock('../../src/cron/sync', () => ({
  registerWithCentral: vi.fn().mockResolvedValue(undefined),
}))

type Who = { id: string; name: string | null; email: string } | null
type ConfigBody = Record<string, unknown> & {
  ai_context?: string
  ai_context_changed_at?: string | null
  ai_context_changed_by?: Who
  relevance_question_changed_at?: string | null
  relevance_question_changed_by?: Who
  tag_taxonomy_changed_at?: string | null
  tag_taxonomy_changed_by?: Who
}

const KEYS = ['ai_context', 'relevance_question', 'tag_taxonomy'] as const

describe('who changed each AI setting (admin API)', () => {
  let adminId: string
  let adminCookie: string
  let ownerId: string
  let ownerCookie: string
  let memberCookie: string
  let baseline: Awaited<ReturnType<typeof allRows>>
  const db = () => getDb(env.DB)

  const put = (cookie: string | null, body: unknown, e: Record<string, unknown> = env) =>
    app.request('/api/admin/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: JSON.stringify(body),
    }, e)
  const config = async (cookie = adminCookie) => {
    const res = await app.request('/api/admin/config', { headers: { Cookie: cookie } }, env)
    expect(res.status).toBe(200)
    return await res.json() as ConfigBody
  }
  const allRows = async () => (await db().select().from(associationConfig).all())
    .sort((a, b) => a.key.localeCompare(b.key))
  const at = (iso: string) => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(iso)) }

  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    adminId = await seedUser({ role: 'admin', email: 'admin@example.com', name: 'Avery Admin' })
    adminCookie = `session=${await seedSession(adminId)}`
    ownerId = await seedUser({ role: 'owner', email: 'owner@example.com', name: 'Olive Owner' })
    ownerCookie = `session=${await seedSession(ownerId)}`
    memberCookie = `session=${await seedSession(await seedUser({ role: 'member', email: 'member@example.com', name: 'Mo Member' }))}`
    baseline = await allRows()
  })

  afterEach(async () => {
    vi.useRealTimers()
    await env.DB.prepare('DROP TRIGGER IF EXISTS fail_ai_record').run()
    await env.DB.prepare('DROP TRIGGER IF EXISTS fail_ai_value').run()
  })

  const VALUES: Record<(typeof KEYS)[number], unknown> = {
    ai_context: 'Summarize for clerks.',
    relevance_question: 'How much does this touch ballots?',
    tag_taxonomy: [{ name: 'Voting', description: 'Ballots and access' }],
  }

  describe('recording a change', () => {
    it.each(KEYS)('records the admin and the time when %s is saved, and the config shows them', async (key) => {
      at('2026-10-20T14:05:09Z')
      const res = await put(adminCookie, { [key]: VALUES[key] })
      expect(res.status).toBe(200)
      const body = await config()
      expect(body[`${key}_changed_at`]).toBe('2026-10-20 14:05:09')
      expect(body[`${key}_changed_by`]).toEqual({ id: adminId, name: 'Avery Admin', email: 'admin@example.com' })
    })

    it('records the latest change, so a second admin\'s edit names them', async () => {
      at('2026-10-20T14:05:09Z')
      await put(adminCookie, { ai_context: 'First.' })
      at('2026-10-21T08:00:00Z')
      await put(ownerCookie, { ai_context: 'Second.' })
      const body = await config()
      expect(body.ai_context).toBe('Second.')
      expect(body.ai_context_changed_at).toBe('2026-10-21 08:00:00')
      expect(body.ai_context_changed_by).toEqual({ id: ownerId, name: 'Olive Owner', email: 'owner@example.com' })
    })

    it('records all three when one save changes all three', async () => {
      at('2026-10-20T14:05:09Z')
      await put(adminCookie, VALUES)
      const body = await config()
      for (const key of KEYS) {
        expect(body[`${key}_changed_at`]).toBe('2026-10-20 14:05:09')
        expect(body[`${key}_changed_by`]).toMatchObject({ id: adminId })
      }
    })

    it('records a reset to the default (null) as a change, and keeps the record after the value is gone', async () => {
      at('2026-10-20T14:05:09Z')
      await put(adminCookie, { ai_context: 'Custom.' })
      at('2026-10-22T10:00:00Z')
      await put(ownerCookie, { ai_context: null })
      const body = await config()
      expect(body.ai_context).toBeUndefined()
      expect(body.ai_context_changed_at).toBe('2026-10-22 10:00:00')
      expect(body.ai_context_changed_by).toMatchObject({ id: ownerId })
    })

    it('records a change to a value stored before there was any record', async () => {
      await db().insert(associationConfig).values({ key: 'relevance_question', value: JSON.stringify('Old question?') })
      at('2026-10-20T14:05:09Z')
      await put(adminCookie, { relevance_question: 'New question?' })
      expect((await config()).relevance_question_changed_by).toMatchObject({ id: adminId })
    })

    it('records a change to a taxonomy edited in place', async () => {
      await put(adminCookie, { tag_taxonomy: [{ name: 'Voting' }, { name: 'Courts' }] })
      at('2026-10-23T09:00:00Z')
      await put(ownerCookie, { tag_taxonomy: [{ name: 'Voting' }, { name: 'Courts', description: 'Judicial bills' }] })
      const body = await config()
      expect(body.tag_taxonomy_changed_at).toBe('2026-10-23 09:00:00')
      expect(body.tag_taxonomy_changed_by).toMatchObject({ id: ownerId })
    })
  })

  describe('a save that changes nothing', () => {
    it('records nothing when the same values are saved again', async () => {
      at('2026-10-20T14:05:09Z')
      await put(adminCookie, VALUES)
      const before = await allRows()
      at('2026-10-25T09:00:00Z')
      const res = await put(ownerCookie, VALUES)
      expect(res.status).toBe(200)
      expect(await allRows()).toEqual(before)
      const body = await config()
      expect(body.ai_context_changed_by).toMatchObject({ id: adminId })
      expect(body.ai_context_changed_at).toBe('2026-10-20 14:05:09')
    })

    it('records nothing for a taxonomy saved with the same items, in any key order', async () => {
      await put(adminCookie, { tag_taxonomy: [{ name: 'Voting', description: 'Ballots' }] })
      const before = await allRows()
      await put(ownerCookie, { tag_taxonomy: [{ description: 'Ballots', name: 'Voting' }] })
      expect(await allRows()).toEqual(before)
    })

    it('records nothing when null is saved over a setting that was never set', async () => {
      const res = await put(adminCookie, { ai_context: null, relevance_question: null, tag_taxonomy: null })
      expect(res.status).toBe(200)
      expect(await allRows()).toEqual(baseline)
      const body = await config()
      for (const key of KEYS) {
        expect(body[`${key}_changed_at`] ?? null).toBeNull()
        expect(body[`${key}_changed_by`] ?? null).toBeNull()
      }
    })

    it('records nothing for a setting that is unchanged within a save that changes another', async () => {
      at('2026-10-20T14:05:09Z')
      await put(adminCookie, { ai_context: 'Same.', relevance_question: 'Same question?' })
      at('2026-10-21T08:00:00Z')
      await put(ownerCookie, { ai_context: 'Same.', relevance_question: 'Different question?' })
      const body = await config()
      expect(body.ai_context_changed_at).toBe('2026-10-20 14:05:09')
      expect(body.ai_context_changed_by).toMatchObject({ id: adminId })
      expect(body.relevance_question_changed_at).toBe('2026-10-21 08:00:00')
      expect(body.relevance_question_changed_by).toMatchObject({ id: ownerId })
    })
  })

  describe('one setting does not touch another\'s record', () => {
    it('leaves the other two records alone when one setting changes', async () => {
      at('2026-10-20T14:05:09Z')
      await put(adminCookie, VALUES)
      at('2026-10-21T08:00:00Z')
      await put(ownerCookie, { tag_taxonomy: [{ name: 'Courts' }] })
      const body = await config()
      expect(body.ai_context_changed_by).toMatchObject({ id: adminId })
      expect(body.ai_context_changed_at).toBe('2026-10-20 14:05:09')
      expect(body.relevance_question_changed_by).toMatchObject({ id: adminId })
      expect(body.tag_taxonomy_changed_by).toMatchObject({ id: ownerId })
      expect(body.tag_taxonomy_changed_at).toBe('2026-10-21 08:00:00')
    })

    it('records nothing for the AI settings when a save changes only other settings', async () => {
      await put(adminCookie, { association_name: 'Test Org', keywords: ['ballot'], new_match_min_relevance: 3 })
      const keys = (await allRows()).map(r => r.key)
      expect(keys.some(k => k.includes('_changed'))).toBe(false)
      const body = await config()
      for (const key of KEYS) expect(body[`${key}_changed_by`] ?? null).toBeNull()
    })
  })

  describe('a setting never changed', () => {
    it('shows no record, not a placeholder, for settings stored before records existed', async () => {
      await db().insert(associationConfig).values([
        { key: 'ai_context', value: JSON.stringify('Summarize for clerks.') },
        { key: 'relevance_question', value: JSON.stringify('How much does this touch ballots?') },
        { key: 'tag_taxonomy', value: JSON.stringify([{ name: 'Voting' }]) },
      ])
      const body = await config()
      expect(body.ai_context).toBe('Summarize for clerks.')
      for (const key of KEYS) {
        expect(body[`${key}_changed_at`] ?? null).toBeNull()
        expect(body[`${key}_changed_by`] ?? null).toBeNull()
      }
    })

    it('reads an unreadable record as no record', async () => {
      await db().insert(associationConfig).values({ key: 'ai_context_changed', value: '{not json' })
      const body = await config()
      expect(body.ai_context_changed_at ?? null).toBeNull()
      expect(body.ai_context_changed_by ?? null).toBeNull()
    })
  })

  describe('a removed admin', () => {
    it('keeps the time and names no one when the admin who made the change was removed', async () => {
      at('2026-10-20T14:05:09Z')
      await put(adminCookie, { ai_context: 'Custom.' })
      await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(adminId).run()
      await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(adminId).run()
      const res = await app.request('/api/admin/config', { headers: { Cookie: ownerCookie } }, env)
      expect(res.status).toBe(200)
      const body = await res.json() as ConfigBody
      expect(body.ai_context).toBe('Custom.')
      expect(body.ai_context_changed_at).toBe('2026-10-20 14:05:09')
      expect(body.ai_context_changed_by ?? null).toBeNull()
    })
  })

  describe('the value and its record land together', () => {
    it('leaves the value unchanged when the record cannot be written', async () => {
      await put(adminCookie, { ai_context: 'Original.' })
      const before = await allRows()
      // A real database failure on the record row only, so the value write
      // before it in the same request is what must be undone.
      await env.DB.prepare(
        `CREATE TRIGGER fail_ai_record BEFORE UPDATE ON association_config WHEN NEW.key = 'ai_context_changed' BEGIN SELECT RAISE(ABORT, 'record write failed'); END`,
      ).run()
      const res = await app.request('/api/admin/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
        body: JSON.stringify({ ai_context: 'Changed.', relevance_question: 'Also changed?' }),
      }, env)
      expect(res.status).toBeGreaterThanOrEqual(500)
      expect(await allRows()).toEqual(before)
    })

    it('leaves the record unchanged when the value cannot be written', async () => {
      await put(adminCookie, { ai_context: 'Original.' })
      const before = await allRows()
      await env.DB.prepare(
        `CREATE TRIGGER fail_ai_value BEFORE UPDATE ON association_config WHEN NEW.key = 'ai_context' BEGIN SELECT RAISE(ABORT, 'value write failed'); END`,
      ).run()
      const res = await app.request('/api/admin/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
        body: JSON.stringify({ ai_context: 'Changed.' }),
      }, env)
      expect(res.status).toBeGreaterThanOrEqual(500)
      expect(await allRows()).toEqual(before)
    })
  })

  describe('who can change settings and read the record', () => {
    it('refuses a member with 403, changing and recording nothing', async () => {
      const res = await put(memberCookie, { ai_context: 'Sneaky.' })
      expect(res.status).toBe(403)
      expect(await allRows()).toEqual(baseline)
    })

    it('refuses a request with no session with 401, changing nothing', async () => {
      expect((await put(null, { ai_context: 'Sneaky.' })).status).toBe(401)
      expect(await allRows()).toEqual(baseline)
    })

    it('does not let a member read the admin config that carries the record', async () => {
      await put(adminCookie, { ai_context: 'Custom.' })
      const res = await app.request('/api/admin/config', { headers: { Cookie: memberCookie } }, env)
      expect(res.status).toBe(403)
    })

    it('does not put the record in the config a member can read', async () => {
      await put(adminCookie, { ai_context: 'Custom.' })
      const res = await app.request('/api/config', { headers: { Cookie: memberCookie } }, env)
      expect(res.status).toBe(200)
      const text = await res.text()
      expect(text).not.toContain('Avery Admin')
      expect(text).not.toContain('admin@example.com')
      expect(text).not.toContain('_changed')
    })

    it('does not accept the record itself as a config key to write', async () => {
      const res = await put(adminCookie, { ai_context_changed: JSON.stringify({ by: ownerId, at: '2020-01-01 00:00:00' }) })
      expect(res.status).toBe(400)
      expect(await allRows()).toEqual(baseline)
    })

    it('is locked on a demo instance, recording nothing', async () => {
      const res = await put(adminCookie, { ai_context: 'Custom.' }, { ...env, DEMO_MODE: 'true' })
      expect(res.status).toBe(403)
      expect(await allRows()).toEqual(baseline)
    })

    it('rejects an unknown key with 400, writing and recording nothing for the known one', async () => {
      const res = await put(adminCookie, { ai_context: 'Custom.', not_a_key: 1 })
      expect(res.status).toBe(400)
      expect(await allRows()).toEqual(baseline)
    })
  })

  describe('the other settings in the same save', () => {
    it('still writes them, and keeps its other behavior', async () => {
      const res = await put(adminCookie, { association_name: 'Test Org', ai_context: 'Custom.', keywords: ['ballot'] })
      expect(res.status).toBe(200)
      const body = await config()
      expect(body.association_name).toBe('Test Org')
      expect(body.keywords).toEqual(['ballot'])
      expect(body.ai_context).toBe('Custom.')
    })
  })
})
