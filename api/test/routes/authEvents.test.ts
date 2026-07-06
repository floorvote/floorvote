import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { resetDb, applyMigrations } from '../helpers'
import { getDb } from '../../src/db/client'
import { authEvents } from '../../src/db/schema'

describe('auth_events table', () => {
  beforeEach(async () => { await resetDb(); await applyMigrations() })

  it('accepts an inserted row and reads it back', async () => {
    const db = getDb(env.DB)
    await db.insert(authEvents).values({
      id: crypto.randomUUID(), email: 'x@y.com', event: 'link_requested', linkType: 'login',
    })
    const rows = await db.select().from(authEvents).all()
    expect(rows).toHaveLength(1)
    expect(rows[0].event).toBe('link_requested')
  })
})
