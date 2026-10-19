import { describe, it, expect } from 'vitest'
import { digestOf, keepDigest, loadDigest, mergeDigest, readMark, writeMark, type Digest, type Mark } from '../../../src/providers/govinfo/changes'

// What a GovInfo bill sync keeps of the meeting entries it put on records, and
// the mark its ETag carries (#616). The cache is a plain map standing in for
// ProviderContext.cache.

function memoryCache() {
  const entries = new Map<string, string>()
  return {
    entries,
    cache: {
      async list(prefix: string) { return new Map([...entries].filter(([k]) => k.startsWith(prefix))) },
      async put(add: Readonly<Record<string, string>>) { for (const [k, v] of Object.entries(add)) entries.set(k, v) },
      async drop(keys: readonly string[]) { for (const k of keys) entries.delete(k) },
    },
  }
}

/** A digest for a Congress where this many bills have meetings, each with its own short hash. */
function bigDigest(bills: number): Digest {
  const d: Digest = new Map()
  for (let i = 1; i <= bills; i++) d.set(`119/HCONRES${i}`, (i * 2654435761 >>> 0).toString(16).padStart(16, '0').slice(0, 16))
  return d
}

const mark = (meetings: string | null): Mark => ({ congress: 119, since: '2026-10-17T00:19:30Z', full: '2026-10-19', types: ['hr', 's'], meetings })

describe('the digest of what a pass put on records', () => {
  it('reads back what it kept, for a Congress where thousands of bills have meetings', async () => {
    const { cache } = memoryCache()
    const digest = bigDigest(6000)
    const id = (await keepDigest({ cache }, 119, digest, null))!
    expect(id).toMatch(/^[0-9a-f]{16}$/)
    expect(await loadDigest({ cache }, 119, id)).toEqual(digest)
  })

  it('keeps no entry larger than one D1 statement takes', async () => {
    const { cache, entries } = memoryCache()
    await keepDigest({ cache }, 119, bigDigest(6000), null)
    expect(entries.size).toBeGreaterThan(1)
    for (const v of entries.values()) expect(v.length).toBeLessThanOrEqual(32 * 1024)
  })

  it('reads nothing back when a piece of it is gone, or isn\'t what was kept', async () => {
    const { cache, entries } = memoryCache()
    const id = (await keepDigest({ cache }, 119, bigDigest(6000), null))!
    const keys = [...entries.keys()].sort()
    const one = keys[1]
    const saved = entries.get(one)!
    entries.delete(one)
    expect(await loadDigest({ cache }, 119, id)).toBeNull()
    entries.set(one, saved.replace(/[0-9a-f]{16}/, '0000000000000000'))
    expect(await loadDigest({ cache }, 119, id)).toBeNull()
    entries.set(one, 'not json')
    expect(await loadDigest({ cache }, 119, id)).toBeNull()
    entries.set(one, saved)
    expect(await loadDigest({ cache }, 119, id)).toEqual(bigDigest(6000))
  })

  it('reads nothing back for an id it never kept', async () => {
    const { cache } = memoryCache()
    await keepDigest({ cache }, 119, bigDigest(10), null)
    expect(await loadDigest({ cache }, 119, '0123456789abcdef')).toBeNull()
  })

  it('keeps an empty digest, for a Congress whose meetings take up no bill', async () => {
    const { cache } = memoryCache()
    const id = (await keepDigest({ cache }, 119, new Map(), null))!
    expect(await loadDigest({ cache }, 119, id)).toEqual(new Map())
  })

  it('keeps only the new digest and the one the previous mark names, of any Congress', async () => {
    const { cache } = memoryCache()
    const a = (await keepDigest({ cache }, 118, bigDigest(3), null))!
    const b = (await keepDigest({ cache }, 119, bigDigest(4000), { ...mark(null), congress: 118, meetings: a }))!
    const c = (await keepDigest({ cache }, 119, bigDigest(5), mark(b)))!
    expect(await loadDigest({ cache }, 118, a)).toBeNull()
    expect(await loadDigest({ cache }, 119, b)).toEqual(bigDigest(4000))
    expect(await loadDigest({ cache }, 119, c)).toEqual(bigDigest(5))
    // With no digest of its own (no meetings on records), it keeps only the previous mark's.
    expect(await keepDigest({ cache }, 119, null, mark(c))).toBeNull()
    expect(await loadDigest({ cache }, 119, b)).toBeNull()
    expect(await loadDigest({ cache }, 119, c)).toEqual(bigDigest(5))
  })

  it('gives the same id to the same entries, whatever order they came in', async () => {
    const { cache } = memoryCache()
    const forward = bigDigest(50)
    const backward = new Map([...forward].reverse())
    expect(await keepDigest({ cache }, 119, forward, null)).toBe(await keepDigest({ cache }, 119, backward, null))
  })

  it('hashes each bill\'s entries, and leaves out a bill with none', async () => {
    const entry = { type_id: 1, type: 'Hearing', date: '2026-10-06', time: '09:00', location: '', description: 'x', event_hash: 'h', event_id: '1' }
    const d = await digestOf(new Map([['119/HR1', [entry]], ['119/HR2', [{ ...entry, time: '10:00' }]]]))
    expect([...d.keys()]).toEqual(['119/HR1', '119/HR2'])
    expect(d.get('119/HR1')).toMatch(/^[0-9a-f]{16}$/)
    expect(d.get('119/HR1')).not.toBe(d.get('119/HR2'))
  })
})

describe('the mark an ETag carries', () => {
  it('reads back what it wrote', () => {
    expect(readMark(writeMark(mark('0123456789abcdef')), 119)).toEqual(mark('0123456789abcdef'))
    expect(readMark(writeMark(mark(null)), 119)).toEqual(mark(null))
  })

  it.each([
    ['no ETag', null],
    ['an ETag that isn\'t JSON', 'W/"abc"'],
    ['JSON that isn\'t a mark', '[1,2]'],
    ['another version', JSON.stringify({ ...JSON.parse(writeMark(mark(null))), v: 2 })],
    ['another Congress', writeMark({ ...mark(null), congress: 118 })],
    ['a watermark that isn\'t a time', writeMark({ ...mark(null), since: 'yesterday' })],
    ['a full-read day that isn\'t a day', writeMark({ ...mark(null), full: '19 Oct' })],
    ['a type that isn\'t one of the eight', writeMark({ ...mark(null), types: ['hr', 'hb' as any] })],
    ['a digest id that isn\'t one', writeMark({ ...mark(null), meetings: 'xyz' })],
  ])('reads %s as no mark, a read in full', (_what, etag) => {
    expect(readMark(etag, 119)).toBeNull()
  })
})

describe('merging the digest with the entries now', () => {
  const d = (o: Record<string, string>): Digest => new Map(Object.entries(o))

  it('names each listed bill whose entries changed, came, or went, and keeps the entries now for it', () => {
    const before = d({ '119/HR1': 'a', '119/HR2': 'b', '119/HR3': 'c' })
    const now = d({ '119/HR1': 'a', '119/HR2': 'B', '119/HR4': 'd' })
    const { changed, digest } = mergeDigest(before, now, () => true)
    expect(changed.sort()).toEqual(['119/HR2', '119/HR3', '119/HR4'])
    expect(digest).toEqual(now)
  })

  it('keeps what the last digest said of a bill GovInfo doesn\'t list, and doesn\'t name it', () => {
    const before = d({ '119/HR1': 'a', '119/HR9': 'x' })
    const now = d({ '119/HR1': 'a', '119/HR9': 'y', '119/HR8': 'z' })
    const { changed, digest } = mergeDigest(before, now, key => key === '119/HR1')
    expect(changed).toEqual([])
    expect(digest).toEqual(d({ '119/HR1': 'a', '119/HR9': 'x' }))
  })
})
