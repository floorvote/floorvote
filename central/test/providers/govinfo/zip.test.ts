import { describe, it, expect } from 'vitest'
import { zipSync } from 'fflate'
import { readZip } from '../../../src/providers/govinfo/zip'
import { buildZip, serveZip, zipLayout } from '../../helpers/govinfoZip'
import realZipBase64 from '../../fixtures/govinfo/real-sconres-sample.zip.b64?raw'

// The streaming zip reader behind every GovInfo download: one entry at a
// time, never the whole zip in memory, and an error for anything that isn't a
// complete zip.

const dec = new TextDecoder()
const enc = new TextEncoder()

/** Read a zip, returning each entry's name and text, in the order they came. */
async function read(res: Response, opts?: { maxEntryBytes?: number }) {
  const got: { name: string; text: string }[] = []
  const summary = await readZip(res, (name, data) => { got.push({ name, text: dec.decode(data) }) }, opts)
  return { got, summary }
}

const entries = (n: number, size = 300) =>
  Array.from({ length: n }, (_, i) => ({ name: `BILLSTATUS-119hr${i + 1}.xml`, data: `<a>${`bill ${i + 1} `.repeat(size / 8)}</a>` }))

describe('reading a zip as GovInfo builds it', () => {
  it('reads the entries of a zip GovInfo itself wrote, deflated with data descriptors, in order', async () => {
    // Entries 2, 5, and 40 of GovInfo's own BILLSTATUS-119-sconres.zip, copied byte for byte with a rebuilt central directory.
    const bytes = Uint8Array.from(atob(realZipBase64.trim()), c => c.charCodeAt(0))
    const { got, summary } = await read(serveZip(bytes, { chunkSize: 700 }).response)
    expect(got.map(g => g.name)).toEqual(['BILLSTATUS-119sconres2.xml', 'BILLSTATUS-119sconres5.xml', 'BILLSTATUS-119sconres40.xml'])
    for (const g of got) {
      expect(g.text.startsWith('<?xml version="1.0" encoding="utf-8" standalone="no"?>'), g.name).toBe(true)
      expect(g.text.trimEnd().endsWith('</billStatus>'), g.name).toBe(true)
    }
    expect(summary.entries).toBe(3)
  })

  it('reads the same entries however the body is cut into chunks', async () => {
    const zip = buildZip(entries(12))
    const expected = entries(12).map(e => ({ name: e.name, text: e.data }))
    for (const chunkSize of [1, 7, 30, 31, 100, 4096, zip.length]) {
      expect((await read(serveZip(zip, { chunkSize }).response)).got, `chunks of ${chunkSize}`).toEqual(expected)
    }
  })

  it('reads entries with unicode, a large entry, and an empty one', async () => {
    const big = 'x'.repeat(3_000_000)
    const unicode = '<a>Veterans’ — Español</a>'
    const zip = buildZip([{ name: 'a.xml', data: unicode }, { name: 'b.xml', data: big }, { name: 'c.xml', data: '' }])
    const { got } = await read(serveZip(zip, { chunkSize: 64 * 1024 }).response)
    expect(got).toEqual([{ name: 'a.xml', text: unicode }, { name: 'b.xml', text: big }, { name: 'c.xml', text: '' }])
  })

  it('reads a zip with no entries as no entries, having read it to its end', async () => {
    const empty = buildZip([])
    const served = serveZip(empty)
    expect((await read(served.response)).got).toEqual([])
    expect(served.pulled()).toBe(empty.length)
    const bare = zipSync({})
    const servedBare = serveZip(bare)
    expect((await read(servedBare.response)).summary.entries).toBe(0)
    expect(servedBare.pulled()).toBe(bare.length)
  })

  it('reads a zip whose entries carry their sizes in the local headers, as other zippers write them', async () => {
    const zip = zipSync({ 'a.xml': enc.encode('<a>one</a>'), 'b.xml': enc.encode('<b>two</b>') })
    expect((await read(serveZip(zip, { chunkSize: 5 }).response)).got).toEqual([
      { name: 'a.xml', text: '<a>one</a>' }, { name: 'b.xml', text: '<b>two</b>' },
    ])
  })

  it('skips the directory entries a zip may hold', async () => {
    const zip = zipSync({ 'dir/': new Uint8Array(0), 'dir/a.xml': enc.encode('<a/>') })
    expect((await read(serveZip(zip).response)).got.map(g => g.name)).toEqual(['dir/a.xml'])
  })
})

describe('reading as a stream', () => {
  it('hands over each entry while the rest of the zip is still unread', async () => {
    const zip = buildZip(entries(60, 4000))
    const layout = zipLayout(zip)
    const served = serveZip(zip, { chunkSize: 2048 })
    const seen: { index: number; pulled: number }[] = []
    let index = 0
    await readZip(served.response, () => { seen.push({ index: index++, pulled: served.pulled() }) })
    expect(seen).toHaveLength(60)
    // The first entry is handed over after a sliver of the zip, not after all of it.
    expect(seen[0].pulled).toBeLessThan(zip.length / 10)
    // Every entry arrives within a few chunks of where it ends in the zip.
    for (const s of seen) {
      const end = s.index + 1 < 60 ? layout.entryStarts[s.index + 1] : layout.centralDirectory
      expect(s.pulled - end, `entry ${s.index}`).toBeLessThan(2048 * 4)
    }
  })

  it('reads every entry of a body that can only be read a chunk at a time', async () => {
    // serveZip makes arrayBuffer(), text(), blob(), bytes(), json(), and formData() throw, so
    // reading all 40 entries means reading the body's stream.
    const zip = buildZip(entries(40, 20_000))
    const served = serveZip(zip, { chunkSize: 8192 })
    for (const method of ['arrayBuffer', 'text', 'blob', 'bytes', 'json', 'formData'] as const) {
      expect(() => (served.response as any)[method](), method).toThrow(/read whole/)
    }
    const { got } = await read(served.response)
    expect(got).toHaveLength(40)
    expect(served.pulled()).toBe(zip.length)
  })

  it('stops reading and says so when one entry is larger than it allows', async () => {
    const zip = buildZip([{ name: 'a.xml', data: '<a/>' }, { name: 'huge.xml', data: 'x'.repeat(2_000_000) }, { name: 'c.xml', data: '<c/>' }])
    const served = serveZip(zip, { chunkSize: 512 })
    await expect(readZip(served.response, () => {}, { maxEntryBytes: 1_000_000 })).rejects.toThrow(/huge\.xml.*too large|too large.*huge\.xml/i)
    // It gave up on the entry, not after reading the whole zip.
    expect(served.pulled()).toBeLessThan(zip.length)
  })

  it('allows an entry up to the limit', async () => {
    const zip = buildZip([{ name: 'a.xml', data: 'x'.repeat(1000) }])
    await expect(readZip(serveZip(zip).response, () => {}, { maxEntryBytes: 1000 })).resolves.toEqual(expect.objectContaining({ entries: 1 }))
  })

  it('reads GovInfo\'s largest bill, 2.5 MB of XML, with the default limit', async () => {
    const zip = buildZip([{ name: 'big.xml', data: 'x'.repeat(2_600_000) }])
    await expect(readZip(serveZip(zip, { chunkSize: 65536 }).response, () => {})).resolves.toEqual(expect.objectContaining({ entries: 1 }))
  })
})

describe('failing closed', () => {
  const zip = buildZip(entries(8))
  const layout = zipLayout(zip)
  const rejects = (bytes: Uint8Array, opts?: Parameters<typeof serveZip>[1]) =>
    expect(read(serveZip(bytes, { contentLength: null, ...opts }).response)).rejects.toThrow(/ZIP/i)

  it.each([500, 404, 403, 429, 204, 301])('on an answer of %i', async (status) => {
    await expect(read(new Response(status === 204 ? null : 'x', { status }))).rejects.toThrow(String(status))
  })

  it('on an answer with no body', async () => {
    await expect(read(new Response(null, { status: 200 }))).rejects.toThrow(/ZIP/i)
  })

  it('on a body that isn\'t a zip', async () => {
    await rejects(enc.encode('<html><body>Service unavailable</body></html>'))
    await rejects(enc.encode('PK'))
    await rejects(new Uint8Array(0))
  })

  it('cut off partway through any entry, and wherever else in the zip', async () => {
    const cuts = new Set<number>()
    for (const start of layout.entryStarts) for (const d of [1, 3, 10, 29, 31, 60, 100]) cuts.add(start + d)
    for (const d of [0, 1, 20, 50, 100, 300]) cuts.add(layout.centralDirectory + d)
    for (const d of [1, 2, 10, 21]) cuts.add(zip.length - d)
    for (const at of cuts) {
      if (at <= 0 || at >= zip.length) continue
      await expect(read(serveZip(zip.slice(0, at), { contentLength: null }).response), `cut at ${at} of ${zip.length}`).rejects.toThrow(/ZIP/i)
    }
  })

  it('cut off exactly between two entries', async () => {
    for (const start of layout.entryStarts.slice(1)) await rejects(zip.slice(0, start))
    await rejects(zip.slice(0, layout.centralDirectory))
  })

  it('shorter or longer than the length it announced', async () => {
    await expect(read(serveZip(zip.slice(0, zip.length - 50), { contentLength: zip.length }).response)).rejects.toThrow(/ZIP/i)
    await expect(read(serveZip(zip, { contentLength: zip.length - 5 }).response)).rejects.toThrow(/ZIP/i)
  })

  it('with a central directory that counts a different number of entries', async () => {
    const lie = zip.slice()
    new DataView(lie.buffer).setUint16(lie.length - 22 + 10, 9, true)
    await rejects(lie)
    const fewer = zip.slice()
    new DataView(fewer.buffer).setUint16(fewer.length - 22 + 10, 7, true)
    await rejects(fewer)
  })

  it('with trailing bytes after the end of the zip', async () => {
    await rejects(Uint8Array.from([...zip, ...enc.encode('extra')]))
  })

  it('with deflated data that is corrupt', async () => {
    const bad = zip.slice()
    // The second entry's data starts after its 30-byte header and name.
    const at = layout.entryStarts[1] + 30 + 'BILLSTATUS-119hr2.xml'.length
    for (let i = 0; i < 40; i++) bad[at + i] = 0xFF
    await rejects(bad)
  })

  it('and tells the caller\'s handler\'s own error apart: an error it throws for an entry stops the read', async () => {
    const served = serveZip(zip, { chunkSize: 256 })
    await expect(readZip(served.response, (name) => { if (name.endsWith('hr3.xml')) throw new Error('bad bill') })).rejects.toThrow('bad bill')
    expect(served.pulled()).toBeLessThan(zip.length)
  })
})
