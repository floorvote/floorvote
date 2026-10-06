import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { applyMigrations, resetDb, parseMigration } from '../helpers'
import migrationSql from '../../migrations/0075_auth_events_email_changed.sql?raw'

describe('migration 0075_auth_events_email_changed', () => {
  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
  })

  const insert = (event: string, actorId: string | null = null) => env.DB.prepare(
    `INSERT INTO auth_events (id, user_id, email, event, actor_id) VALUES (?, 'u1', 'a@example.com', ?, ?)`,
  ).bind(crypto.randomUUID(), event, actorId).run()

  it('accepts email_changed with an actor, and still rejects an unknown event', async () => {
    await insert('email_changed', 'admin-1')
    const row = await env.DB.prepare(`SELECT event, actor_id FROM auth_events`).first()
    expect(row).toEqual({ event: 'email_changed', actor_id: 'admin-1' })
    await expect(insert('not_an_event')).rejects.toThrow()
  })

  it('keeps every earlier event type allowed', async () => {
    for (const e of [
      'link_requested', 'link_requested_unknown', 'email_sent', 'email_send_failed', 'email_bounced',
      'verify_success', 'verify_failed', 'logout', 'rate_limited', 'email_delivered', 'email_complained',
    ]) await insert(e)
    const { results } = await env.DB.prepare(`SELECT COUNT(*) AS n FROM auth_events`).all()
    expect(results[0]).toEqual({ n: 11 })
  })

  it('carries existing rows across the rebuild and restores the indexes', async () => {
    await env.DB.prepare(
      `INSERT INTO auth_events (id, user_id, email, event, reason, link_type, provider, message_id, user_agent, ip_country, created_at)
       VALUES ('e1', 'u1', 'a@example.com', 'email_bounced', 'user unknown', 'invite', 'cloudflare', 'm1', 'ua', 'US', '2026-01-01 00:00:00')`,
    ).run()
    // Re-running the rebuild over a populated table exercises the copy step.
    const { queries } = parseMigration(migrationSql, '0075')
    await env.DB.batch(queries.map(q => env.DB.prepare(q)))

    const row = await env.DB.prepare(`SELECT * FROM auth_events WHERE id = 'e1'`).first()
    expect(row).toEqual({
      id: 'e1', user_id: 'u1', email: 'a@example.com', event: 'email_bounced', reason: 'user unknown',
      link_type: 'invite', provider: 'cloudflare', message_id: 'm1', user_agent: 'ua', ip_country: 'US',
      created_at: '2026-01-01 00:00:00', actor_id: null,
    })
    const { results } = await env.DB.prepare(`PRAGMA index_list(auth_events)`).all()
    expect((results as Array<{ name: string }>).map(i => i.name).filter(n => n.startsWith('idx_')).sort()).toEqual([
      'idx_auth_events_email_created', 'idx_auth_events_message', 'idx_auth_events_user_created',
    ])
  })
})
