import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { resetDb, applyMigrations, seedUser } from '../helpers'
import { getDb } from '../../src/db/client'
import { countActiveOwners } from '../../src/lib/owners'

describe('countActiveOwners', () => {
  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
  })

  it('returns 1 when there is one active owner', async () => {
    const db = getDb(env.DB)
    await seedUser({ role: 'owner', email: 'owner1@example.com' })
    expect(await countActiveOwners(db)).toBe(1)
  })

  it('returns 2 when there are two active owners', async () => {
    const db = getDb(env.DB)
    await seedUser({ role: 'owner', email: 'owner1@example.com' })
    await seedUser({ role: 'owner', email: 'owner2@example.com' })
    expect(await countActiveOwners(db)).toBe(2)
  })

  it('does not count a deactivated owner', async () => {
    const db = getDb(env.DB)
    await seedUser({ role: 'owner', email: 'owner1@example.com' })
    await seedUser({
      role: 'owner',
      email: 'owner2-deactivated@example.com',
      deactivatedAt: new Date().toISOString(),
    })
    expect(await countActiveOwners(db)).toBe(1)
  })

  it('returns 0 when there are no owners', async () => {
    const db = getDb(env.DB)
    await seedUser({ role: 'member', email: 'member@example.com' })
    expect(await countActiveOwners(db)).toBe(0)
  })
})
