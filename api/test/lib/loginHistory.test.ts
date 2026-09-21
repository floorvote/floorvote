import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { resetDb, applyMigrations, seedUser, seedMagicLink } from '../helpers'
import { getDb } from '../../src/db/client'
import { usedMagicLinkCount } from '../../src/lib/loginHistory'

describe('usedMagicLinkCount', () => {
  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
  })

  it('is 0 for a user who has never used a link — the superadmin JWT case', async () => {
    const id = await seedUser()
    expect(await usedMagicLinkCount(getDb(env.DB), id)).toBe(0)
  })

  it('is 1 for a genuine first-timer, whose link verify has just marked used', async () => {
    const id = await seedUser()
    await seedMagicLink(id, { used: true })
    expect(await usedMagicLinkCount(getDb(env.DB), id)).toBe(1)
  })

  it('is 2 once they log in again', async () => {
    const id = await seedUser()
    await seedMagicLink(id, { used: true })
    await seedMagicLink(id, { used: true })
    expect(await usedMagicLinkCount(getDb(env.DB), id)).toBe(2)
  })

  it('ignores unused links — an outstanding invite is not a login', async () => {
    const id = await seedUser()
    await seedMagicLink(id, { used: false })
    expect(await usedMagicLinkCount(getDb(env.DB), id)).toBe(0)
  })

  it("counts only this user's links", async () => {
    const a = await seedUser()
    const b = await seedUser()
    await seedMagicLink(b, { used: true })
    expect(await usedMagicLinkCount(getDb(env.DB), a)).toBe(0)
  })
})
