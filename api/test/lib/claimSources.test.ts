import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { clearDb } from '../helpers'
import { getDb } from '../../src/db/client'
import { associationConfig } from '../../src/db/schema'
import { claimLinksEnabled } from '../../src/lib/claimSources'

// The per-instance claim links setting (#570) is on by default. Turning it off,
// and who can, is covered in test/routes/adminClaimLinks.test.ts.
describe('claimLinksEnabled', () => {
  beforeEach(async () => {
    await clearDb()
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

  // A row that isn't valid JSON can still be a hand-written `false` with
  // whitespace JSON.parse rejects but String.trim strips. It reads as off.
  it.each([
    ['a BOM', '\uFEFFfalse'],
    ['a non-breaking space', '\u00A0false\u00A0'],
    ['a form feed and a vertical tab', '\f\vfalse'],
    ['an em space', '\u2003false'],
  ])('reads a bare false padded with %s as off', async (_label, value) => {
    const db = getDb(env.DB)
    await db.insert(associationConfig).values({ key: 'claim_links_enabled', value })
    expect(await claimLinksEnabled(db)).toBe(false)
  })

  it.each([
    ['not JSON', '{not json'],
    ['padded text that is not false', '\u00A0maybe\u00A0'],
    ['padded true', '\uFEFFtrue'],
    ['empty', ''],
  ])('reads an unreadable value that is %s as on', async (_label, value) => {
    const db = getDb(env.DB)
    await db.insert(associationConfig).values({ key: 'claim_links_enabled', value })
    expect(await claimLinksEnabled(db)).toBe(true)
  })
})
