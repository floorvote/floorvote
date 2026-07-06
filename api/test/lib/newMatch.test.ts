import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { resetDb, applyMigrations } from '../helpers'
import { getDb } from '../../src/db/client'
import { associationConfig } from '../../src/db/schema'
import { getNewMatchMinRelevance } from '../../src/lib/newMatch'

describe('getNewMatchMinRelevance', () => {
  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
  })

  async function setConfig(value: string) {
    await getDb(env.DB).insert(associationConfig).values({ key: 'new_match_min_relevance', value })
  }

  it('defaults to 0 when unset', async () => {
    expect(await getNewMatchMinRelevance(getDb(env.DB))).toBe(0)
  })

  it('reads a stored plain-string value', async () => {
    await setConfig('40')
    expect(await getNewMatchMinRelevance(getDb(env.DB))).toBe(40)
  })

  it('reads a stored JSON number', async () => {
    await setConfig('55')
    expect(await getNewMatchMinRelevance(getDb(env.DB))).toBe(55)
  })

  it('falls back to 0 for invalid values', async () => {
    await setConfig('not-a-number')
    expect(await getNewMatchMinRelevance(getDb(env.DB))).toBe(0)
  })

  it('falls back to 0 for negative values', async () => {
    await setConfig('-5')
    expect(await getNewMatchMinRelevance(getDb(env.DB))).toBe(0)
  })
})
