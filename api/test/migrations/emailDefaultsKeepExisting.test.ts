import { describe, it, expect, beforeEach, vi } from 'vitest'
import { env } from 'cloudflare:test'
import { resetDb, applyMigrations, seedSession, seedBill } from '../helpers'
import { getDb } from '../../src/db/client'
import { feedEvents } from '../../src/db/schema'
import { runDigest } from '../../src/lib/digest'
import { runWeekAhead } from '../../src/lib/weekAhead'
import { mail, resetMail } from '../mail'

// Migration 0129. From here on an instance that never saved its modules reads as DEFAULT_MODULES, which turns the email
// digest and the week ahead email on. An instance that already has people keeps what it gets today: one that never
// saved its modules gets neither email, so the migration saves an empty set for it. A new database, which has no
// people when its migrations run, saves nothing and starts with the defaults.

vi.mock('../../src/lib/email', async (importOriginal) =>
  (await import('../mail')).withFakeSender(await importOriginal<typeof import('../../src/lib/email')>()))

const modulesRow = async () =>
  (await env.DB.prepare("SELECT value FROM association_config WHERE key = 'modules'").first<{ value: string }>())?.value

describe('migration 0129_email_defaults_for_new_instances', () => {
  beforeEach(async () => {
    await resetDb()
    resetMail()
    mail.sendBatch.mockResolvedValue({ sent: 1, failed: 0, skipped: 0, results: [] })
    await applyMigrations({ before: '0129' })
  })

  const addPerson = async () => {
    await env.DB.prepare("INSERT INTO users (id, email, name, role) VALUES ('m1', 'm1@example.com', 'M', 'member')").run()
    await seedSession('m1')
  }

  it('keeps an instance with people and no saved modules without the digest or the week ahead email', async () => {
    await addPerson()
    const pri = await seedBill({ billNumber: 'P 1', state: 'UT', session: '2026', priority: 'high' })
    await getDb(env.DB).insert(feedEvents).values({ id: crypto.randomUUID(), type: 'position_set' as never, billId: pri, userId: 'system', metadata: JSON.stringify({ position: 'Support' }) })

    await applyMigrations()

    expect(await modulesRow()).toBe('{}')
    expect(await runDigest(env as never, getDb(env.DB))).toMatchObject({ skipped: 'off' })
    expect(await runWeekAhead(env as never, getDb(env.DB))).toEqual({ skipped: 'off' })
    expect(mail.sent()).toEqual([])
  })

  it('leaves an instance that saved its modules as it was', async () => {
    await addPerson()
    const saved = JSON.stringify({ 'email-digest': { enabled: true, settings: { frequency: 'weekly', weeklyDay: '2' } } })
    await env.DB.prepare("INSERT INTO association_config (key, value) VALUES ('modules', ?)").bind(saved).run()

    await applyMigrations()

    expect(await modulesRow()).toBe(saved)
  })

  it('saves nothing for a new database, so it starts with the defaults', async () => {
    await applyMigrations()

    expect(await modulesRow()).toBeUndefined()
  })
})
