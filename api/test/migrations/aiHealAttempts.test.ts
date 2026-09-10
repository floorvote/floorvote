import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { applyMigrations, resetDb } from '../helpers'

describe('migration 0067_ai_heal_attempts', () => {
  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
  })

  it('adds ai_heal_attempts defaulting to 0', async () => {
    const { results } = await env.DB.prepare(`PRAGMA table_info(bills)`).all()
    const col = (results as Array<{ name: string; dflt_value: string | null; notnull: number }>)
      .find(r => r.name === 'ai_heal_attempts')
    expect(col).toBeDefined()
    expect(col!.notnull).toBe(1)
    expect(col!.dflt_value).toBe('0')
  })
})
