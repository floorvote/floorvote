import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { resetDb, applyMigrations } from '../helpers'
import { getDb } from '../../src/db/client'
import { associationConfig } from '../../src/db/schema'
import { claimLinksEnabled } from '../../src/lib/claimSources'

// The per-instance claim links setting (#570) is on by default. Turning it off,
// and who can, is covered in test/routes/adminClaimLinks.test.ts.
describe('claimLinksEnabled', () => {
  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
  })

  it('is on for a new instance with no settings', async () => {
    expect(await claimLinksEnabled(getDb(env.DB))).toBe(true)
  })

  it('is on for an existing instance with AI settings of its own', async () => {
    const db = getDb(env.DB)
    await db.insert(associationConfig).values([
      { key: 'ai_context', value: JSON.stringify('Summarize for clerks.') },
      { key: 'tag_taxonomy', value: JSON.stringify([{ name: 'Voting' }]) },
    ])
    expect(await claimLinksEnabled(db)).toBe(true)
  })
})
