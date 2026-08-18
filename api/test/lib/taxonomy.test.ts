import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { eq } from 'drizzle-orm'
import { resetDb, applyMigrations } from '../helpers'
import { getDb } from '../../src/db/client'
import { associationConfig } from '../../src/db/schema'
import {
  loadEffectiveTaxonomy, loadTaxonomyTagNameSet, filterTagsToTaxonomy, DEFAULT_TAXONOMY,
} from '../../src/lib/taxonomy'

describe('taxonomy helpers', () => {
  beforeEach(async () => { await resetDb(); await applyMigrations() })

  it('filterTagsToTaxonomy keeps only exact-case members', () => {
    const allowed = new Set(['Elections', 'Public Records'])
    expect(filterTagsToTaxonomy(['Elections', 'Land Records', 'Public Records'], allowed))
      .toEqual(['Elections', 'Public Records'])
    expect(filterTagsToTaxonomy(['elections'], allowed)).toEqual([]) // case-sensitive
    expect(filterTagsToTaxonomy([], allowed)).toEqual([])
  })

  it('filterTagsToTaxonomy removes duplicates, keeping first-occurrence order', () => {
    const allowed = new Set(['Elections', 'Public Records'])
    expect(filterTagsToTaxonomy(['Public Records', 'Elections', 'Public Records'], allowed))
      .toEqual(['Public Records', 'Elections'])
    expect(filterTagsToTaxonomy(['Elections', 'Elections'], allowed)).toEqual(['Elections'])
  })

  it('loadEffectiveTaxonomy / loadTaxonomyTagNameSet return the configured taxonomy', async () => {
    const db = getDb(env.DB)
    await db.insert(associationConfig).values({
      key: 'tag_taxonomy',
      value: JSON.stringify([{ name: 'Elections' }, { name: 'Public Records' }]),
    })
    expect((await loadEffectiveTaxonomy(db)).map(t => t.name)).toEqual(['Elections', 'Public Records'])
    expect([...await loadTaxonomyTagNameSet(db)].sort()).toEqual(['Elections', 'Public Records'])
  })

  it('loadEffectiveTaxonomy falls back to DEFAULT when missing / empty / malformed', async () => {
    const db = getDb(env.DB)
    expect(await loadEffectiveTaxonomy(db)).toEqual(DEFAULT_TAXONOMY) // missing row
    await db.insert(associationConfig).values({ key: 'tag_taxonomy', value: JSON.stringify([]) })
    expect(await loadEffectiveTaxonomy(db)).toEqual(DEFAULT_TAXONOMY) // empty array
    await db.update(associationConfig).set({ value: 'not json' }).where(eq(associationConfig.key, 'tag_taxonomy'))
    expect(await loadEffectiveTaxonomy(db)).toEqual(DEFAULT_TAXONOMY) // malformed
  })
})
