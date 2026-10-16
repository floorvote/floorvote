import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { resetDb, applyMigrations, seedBill } from '../helpers'
import { getDb } from '../../src/db/client'
import { associationConfig } from '../../src/db/schema'
import { computeClaimSourceCounts, recordClaimSourcesCutOff } from '../../src/lib/claimSourceCounts'

// Operators see how well claim links resolve (#573): the stored claim sources
// counted by how each quote resolved, plus two signals the reviews asked for.
// All the fixtures are invented.

const NOW = '2026-02-01T00:00:00.000Z'

const item = (status: string, n = 1) =>
  Array.from({ length: n }, (_, i) => ({
    claim: `Claim ${status} ${i}.`,
    quote: `Quote ${status} ${i}`,
    status,
    claimAt: { start: 0, end: 5 },
  }))

/** A bill the analysis has run on, with `claimSources` stored raw (null, a JSON string, or junk). */
async function analyzed(claimSources: unknown[] | string | null, over: { processed?: boolean } = {}): Promise<string> {
  const id = await seedBill({ aiProcessedAt: over.processed === false ? undefined : NOW, tenantSummary: 'A summary.' })
  const raw = claimSources === null ? null : typeof claimSources === 'string' ? claimSources : JSON.stringify(claimSources)
  if (raw !== null) {
    await env.DB.prepare('UPDATE bills SET claim_sources = ?, claim_sources_doc_id = ? WHERE id = ?').bind(raw, '5001', id).run()
  }
  return id
}

const counts = () => computeClaimSourceCounts(getDb(env.DB))

beforeEach(async () => {
  await resetDb()
  await applyMigrations()
})

describe('an instance with no claim sources', () => {
  it('reads all zeros, with all six statuses present', async () => {
    expect(await counts()).toEqual({
      analyses: { withClaimSources: 0, emptyList: 0, noList: 0 },
      items: { exact: 0, normalized: 0, fuzzy: 0, anchored: 0, ungrounded: 0, unverified: 0, total: 0 },
      cutOffRetries: 0,
    })
  })

  it('reads no items when its bills were analyzed before claim links', async () => {
    await analyzed(null)
    await analyzed(null)
    const c = await counts()
    expect(c.items.total).toBe(0)
    expect(c.analyses).toEqual({ withClaimSources: 0, emptyList: 0, noList: 2 })
  })
})

describe('counts by status', () => {
  it('counts each of the six statuses across several bills', async () => {
    await analyzed([...item('exact', 3), ...item('normalized', 1), ...item('ungrounded', 2)])
    await analyzed([...item('exact', 2), ...item('fuzzy', 4), ...item('anchored', 1)])
    await analyzed([...item('unverified', 5), ...item('fuzzy', 1)])
    const { items } = await counts()
    expect(items).toEqual({ exact: 5, normalized: 1, fuzzy: 5, anchored: 1, ungrounded: 2, unverified: 5, total: 19 })
  })

  it('counts unverified, a PDF quote the instance cannot check, on its own', async () => {
    await analyzed([{ claim: 'c', quote: 'q', page: 3, status: 'unverified', claimAt: { start: 0, end: 1 } }])
    expect((await counts()).items).toMatchObject({ unverified: 1, ungrounded: 0, total: 1 })
  })

  it('counts a single bill with one item of one status', async () => {
    await analyzed(item('anchored'))
    expect((await counts()).items).toEqual({ exact: 0, normalized: 0, fuzzy: 0, anchored: 1, ungrounded: 0, unverified: 0, total: 1 })
  })

  it('makes total the sum of the six', async () => {
    await analyzed([...item('exact', 2), ...item('fuzzy', 3), ...item('unverified', 4)])
    const { items } = await counts()
    const { total, ...byStatus } = items
    expect(total).toBe(Object.values(byStatus).reduce((a, b) => a + b, 0))
    expect(total).toBe(9)
  })

  it('counts items on a bill that is not AI-processed too, since the items are what is stored', async () => {
    await analyzed(item('exact', 2), { processed: false })
    expect((await counts()).items.exact).toBe(2)
  })

  it('leaves out an item with no recognized status', async () => {
    // #568 stored {claim, quote} items before #569 resolved them.
    await analyzed([{ claim: 'c', quote: 'q' }, { claim: 'c', quote: 'q', status: 'mystery' }, ...item('exact')])
    const { items } = await counts()
    expect(items.exact).toBe(1)
    expect(items.total).toBe(1)
  })
})

describe('bills with null and empty claim sources', () => {
  it('separates a bill with items, bills asked but stored none, and a bill never asked', async () => {
    await analyzed(item('exact', 2))
    await analyzed([])
    await analyzed([])
    await analyzed(null)
    const { analyses, items } = await counts()
    expect(analyses).toEqual({ withClaimSources: 1, emptyList: 2, noList: 1 })
    expect(items.total).toBe(2)
  })

  it('does not count a bill the analysis has not run on as having no list', async () => {
    await analyzed(null, { processed: false })
    await seedBill({})
    expect((await counts()).analyses).toEqual({ withClaimSources: 0, emptyList: 0, noList: 0 })
  })

  it('counts an empty list as asked, with nothing usable returned, and adds no items', async () => {
    await analyzed([])
    const c = await counts()
    expect(c.analyses.emptyList).toBe(1)
    expect(c.items.total).toBe(0)
  })

  it('ignores stored JSON that is not a list, without failing the other bills', async () => {
    await analyzed('not json at all')
    await analyzed('{"claim":"c"}')
    await analyzed('5')
    await analyzed(item('exact', 2))
    const c = await counts()
    expect(c.items).toMatchObject({ exact: 2, total: 2 })
    // An AI-processed bill whose stored value is no usable list has no list.
    expect(c.analyses).toEqual({ withClaimSources: 1, emptyList: 0, noList: 3 })
  })
})

describe('the cut-off retry count', () => {
  it('is zero until one is recorded', async () => {
    expect((await counts()).cutOffRetries).toBe(0)
  })

  it('counts each recovered cut-off', async () => {
    const db = getDb(env.DB)
    await recordClaimSourcesCutOff(db)
    expect((await counts()).cutOffRetries).toBe(1)
    await recordClaimSourcesCutOff(db)
    await recordClaimSourcesCutOff(db)
    expect((await counts()).cutOffRetries).toBe(3)
  })

  it('counts concurrent cut-offs without losing any', async () => {
    const db = getDb(env.DB)
    await Promise.all(Array.from({ length: 8 }, () => recordClaimSourcesCutOff(db)))
    expect((await counts()).cutOffRetries).toBe(8)
  })

  it('reads a damaged stored value as zero, then counts on from one', async () => {
    const db = getDb(env.DB)
    await db.insert(associationConfig).values({ key: 'claim_sources_cutoff_retries', value: 'junk' })
    expect((await counts()).cutOffRetries).toBe(0)
    await recordClaimSourcesCutOff(db)
    expect((await counts()).cutOffRetries).toBe(1)
  })
})
