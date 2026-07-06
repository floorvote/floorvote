import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { resetDb, applyMigrations } from '../helpers'
import { getDb } from '../../src/db/client'
import { users, sessions } from '../../src/db/schema'
import { ensureDemoSession, DEMO_SESSION_TOKEN, DEMO_SESSION_ID } from '../../src/lib/demoSession'
import { hashToken } from '../../src/lib/crypto'
import { eq } from 'drizzle-orm'

describe('ensureDemoSession — D1 demo session write amplification', () => {
  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    // The shared session references user_id='demo-user'; seed that row.
    await getDb(env.DB).insert(users).values({
      id: 'demo-user',
      email: 'demo@demo.test',
      name: 'Demo',
      role: 'admin',
      subtitle: null,
      canVote: 1,
      emailDigestEnabled: 1,
    })
  })

  it('inserts exactly one shared session row no matter how many times it is called', async () => {
    for (let i = 0; i < 8; i++) await ensureDemoSession(env.DB)
    const rows = await getDb(env.DB).select().from(sessions).where(eq(sessions.userId, 'demo-user')).all()
    expect(rows.length).toBe(1)
    expect(rows[0].id).toBe(DEMO_SESSION_ID)
  })

  it('returns the fixed token, and the row validates as an unexpired session', async () => {
    const token = await ensureDemoSession(env.DB)
    expect(token).toBe(DEMO_SESSION_TOKEN)
    const hash = await hashToken(DEMO_SESSION_TOKEN)
    // Same check requireAuth and the demo middleware use to accept a session.
    const valid = await env.DB.prepare(
      "SELECT 1 FROM sessions WHERE token_hash = ? AND datetime(expires_at) > datetime('now') LIMIT 1",
    )
      .bind(hash)
      .first()
    expect(valid).toBeTruthy()
  })

  it('recreates the shared row after sessions are wiped (nightly-reset self-heal)', async () => {
    await ensureDemoSession(env.DB)
    await env.DB.prepare('DELETE FROM sessions').run()
    await ensureDemoSession(env.DB)
    const rows = await getDb(env.DB).select().from(sessions).where(eq(sessions.userId, 'demo-user')).all()
    expect(rows.length).toBe(1)
  })
})
