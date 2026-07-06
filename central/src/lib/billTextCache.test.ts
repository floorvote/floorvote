import { describe, it, expect } from 'vitest'
import { billTextCacheTtl, textCacheKey, getCachedText, putCachedText } from './billTextCache'

describe('billTextCacheTtl', () => {
  it('defaults to 300 when unset or empty', () => {
    expect(billTextCacheTtl({})).toBe(300)
    expect(billTextCacheTtl({ BILL_TEXT_CACHE_TTL: '' })).toBe(300)
  })
  it('parses a positive override', () => {
    expect(billTextCacheTtl({ BILL_TEXT_CACHE_TTL: '60' })).toBe(60)
  })
  it('treats 0 as disabled', () => {
    expect(billTextCacheTtl({ BILL_TEXT_CACHE_TTL: '0' })).toBe(0)
  })
  it('clamps negative and invalid to 0/default', () => {
    expect(billTextCacheTtl({ BILL_TEXT_CACHE_TTL: '-5' })).toBe(0)
    expect(billTextCacheTtl({ BILL_TEXT_CACHE_TTL: 'abc' })).toBe(300)
  })
})

describe('textCacheKey', () => {
  it('separates variants for the same r2Key', () => {
    const r2Key = 'bills/legiscan-123/texts/9.html'
    expect(textCacheKey('inline', r2Key).url).not.toBe(textCacheKey('json', r2Key).url)
  })
  it('separates distinct r2Keys (new doc → new key, never stale)', () => {
    expect(textCacheKey('json', 'bills/legiscan-123/texts/9.html').url)
      .not.toBe(textCacheKey('json', 'bills/legiscan-123/texts/10.html').url)
  })
  it('encodes the r2Key so slashes do not split the path', () => {
    const url = textCacheKey('inline', 'bills/legiscan-1/texts/2.pdf').url
    expect(url).toContain(encodeURIComponent('bills/legiscan-1/texts/2.pdf'))
  })
})

describe('getCachedText / putCachedText round-trip', () => {
  it('stores and returns a response when TTL > 0', async () => {
    const env = { BILL_TEXT_CACHE_TTL: '300' }
    const key = textCacheKey('json', 'bills/legiscan-777/texts/1.html')
    await putCachedText(env, key, new Response(JSON.stringify({ type: 'html', content: 'hi' }), {
      headers: { 'Content-Type': 'application/json' },
    }))
    const hit = await getCachedText(env, key)
    expect(hit).not.toBeNull()
    expect(await hit!.json()).toEqual({ type: 'html', content: 'hi' })
  })

  it('does not read or write the cache when TTL is 0', async () => {
    const env = { BILL_TEXT_CACHE_TTL: '0' }
    const key = textCacheKey('json', 'bills/legiscan-888/texts/1.html')
    await putCachedText(env, key, new Response('x'))
    expect(await getCachedText(env, key)).toBeNull()
  })

  it('sets a max-age Cache-Control header on the stored response', async () => {
    const env = { BILL_TEXT_CACHE_TTL: '120' }
    const key = textCacheKey('inline', 'bills/legiscan-999/texts/1.html')
    await putCachedText(env, key, new Response('body', { headers: { 'Content-Type': 'text/html' } }))
    const hit = await getCachedText(env, key)
    expect(hit!.headers.get('Cache-Control')).toContain('max-age=120')
  })
})
