import { env } from 'cloudflare:test'
import { describe, it, expect, beforeEach } from 'vitest'
import { drizzle } from 'drizzle-orm/d1'
import * as schema from '../../src/db/schema'
import { providerCacheDrop, providerCacheList, providerCachePut } from '../../src/lib/providerCache'
import { providerContext } from '../../src/lib/providerContext'
import { setupLsDb } from '../helpers/setupLsDb'
import { govinfo } from '../../src/providers/govinfo'

// What a provider keeps between runs (ProviderContext.cache, #619): small text
// entries under keys it names, for what it fetched once and doesn't want to
// fetch again. Each provider has its own: no provider reads another's.

const db = () => drizzle(env.DB, { schema })

beforeEach(async () => {
  await setupLsDb()
})

describe('what a provider keeps between runs', () => {
  it('lists the entries under a prefix, and nothing else', async () => {
    await providerCachePut(db(), 'govinfo', { 'meeting/119/1': 'one', 'meeting/119/2': 'two', 'other/1': 'x' })
    expect(await providerCacheList(db(), 'govinfo', 'meeting/119/')).toEqual(new Map([['meeting/119/1', 'one'], ['meeting/119/2', 'two']]))
  })

  it('matches a prefix exactly: "meeting/1" is not "meeting/10"', async () => {
    await providerCachePut(db(), 'govinfo', { 'meeting/1': 'a', 'meeting/10': 'b', 'meeting/1/x': 'c' })
    expect([...(await providerCacheList(db(), 'govinfo', 'meeting/1/')).keys()]).toEqual(['meeting/1/x'])
    expect([...(await providerCacheList(db(), 'govinfo', 'meeting/10')).keys()]).toEqual(['meeting/10'])
  })

  it('treats "%" and "_" in a prefix as plain characters', async () => {
    await providerCachePut(db(), 'govinfo', { 'a%b': '1', 'axb': '2', 'a_b': '3' })
    expect([...(await providerCacheList(db(), 'govinfo', 'a%')).keys()]).toEqual(['a%b'])
    expect([...(await providerCacheList(db(), 'govinfo', 'a_')).keys()]).toEqual(['a_b'])
  })

  it('replaces an entry that is put again, and keeps the rest', async () => {
    await providerCachePut(db(), 'govinfo', { k1: 'old', k2: 'keep' })
    await providerCachePut(db(), 'govinfo', { k1: 'new' })
    expect(await providerCacheList(db(), 'govinfo', 'k')).toEqual(new Map([['k1', 'new'], ['k2', 'keep']]))
  })

  it('drops the keys it is told to, and ignores one that isn\'t there', async () => {
    await providerCachePut(db(), 'govinfo', { k1: 'a', k2: 'b', k3: 'c' })
    await providerCacheDrop(db(), 'govinfo', ['k1', 'k3', 'never-put'])
    expect(await providerCacheList(db(), 'govinfo', '')).toEqual(new Map([['k2', 'b']]))
  })

  it('keeps each provider\'s entries to itself', async () => {
    await providerCachePut(db(), 'govinfo', { k: 'govinfo\'s' })
    await providerCachePut(db(), 'lims', { k: 'lims\'s' })
    expect(await providerCacheList(db(), 'govinfo', 'k')).toEqual(new Map([['k', 'govinfo\'s']]))
    expect(await providerCacheList(db(), 'lims', 'k')).toEqual(new Map([['k', 'lims\'s']]))
    await providerCacheDrop(db(), 'govinfo', ['k'])
    expect(await providerCacheList(db(), 'lims', 'k')).toEqual(new Map([['k', 'lims\'s']]))
  })

  it('reads and writes more entries than one D1 statement binds', async () => {
    const many = Object.fromEntries(Array.from({ length: 250 }, (_, i) => [`m/${String(i).padStart(4, '0')}`, `value ${i}`]))
    await providerCachePut(db(), 'govinfo', many)
    const listed = await providerCacheList(db(), 'govinfo', 'm/')
    expect(listed.size).toBe(250)
    expect(listed.get('m/0249')).toBe('value 249')
    await providerCacheDrop(db(), 'govinfo', Object.keys(many).slice(0, 240))
    expect([...(await providerCacheList(db(), 'govinfo', 'm/')).keys()]).toEqual(Object.keys(many).slice(240))
  })

  it('stores text of any size a provider keeps, with quotes and newlines intact', async () => {
    const value = JSON.stringify({ title: 'He said "go"\r\nand left', pad: 'x'.repeat(20_000) })
    await providerCachePut(db(), 'govinfo', { k: value })
    expect((await providerCacheList(db(), 'govinfo', 'k')).get('k')).toBe(value)
  })

  it('does nothing for no entries and no keys', async () => {
    await providerCachePut(db(), 'govinfo', { kept: 'x' })
    expect((await providerCacheList(db(), 'govinfo', '')).size).toBe(1)
    await providerCachePut(db(), 'govinfo', {})
    await providerCacheDrop(db(), 'govinfo', [])
    expect([...(await providerCacheList(db(), 'govinfo', '')).keys()]).toEqual(['kept'])
  })

  it('is what a provider reaches as ctx.cache, scoped to that provider', async () => {
    const ctx = providerContext(govinfo, env as any, db())
    await ctx.cache.put({ 'meeting/119/1': 'a' })
    expect(await ctx.cache.list('meeting/')).toEqual(new Map([['meeting/119/1', 'a']]))
    expect(await providerCacheList(db(), 'govinfo', 'meeting/')).toEqual(new Map([['meeting/119/1', 'a']]))
    expect(await providerCacheList(db(), 'lims', 'meeting/')).toEqual(new Map())
    await ctx.cache.drop(['meeting/119/1'])
    expect((await ctx.cache.list('')).size).toBe(0)
  })
})
