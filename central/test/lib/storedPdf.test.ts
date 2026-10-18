import { describe, it, expect } from 'vitest'
import { pdfStreamOrNull, startsWithPdfMagic } from '../../src/lib/storedPdf'

const bytes = (s: string) => Uint8Array.from(s, ch => ch.charCodeAt(0))

/** A stream that hands out `chunks` one pull at a time, recording how many were pulled. */
function chunked(chunks: Uint8Array[]) {
  const state = { pulled: 0, cancelled: false }
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (state.pulled < chunks.length) controller.enqueue(chunks[state.pulled++])
      else controller.close()
    },
    cancel() { state.cancelled = true },
  })
  return { stream, state }
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = []
  const reader = stream.getReader()
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    parts.push(value)
  }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) { out.set(p, at); at += p.length }
  return out
}

describe('pdfStreamOrNull', () => {
  it('returns a stream with every byte, in order, when the body starts with %PDF-', async () => {
    const { stream } = chunked([bytes('%PDF-1.7\nbody'), bytes(' more'), bytes(' end')])
    const out = await pdfStreamOrNull(stream)
    expect(out).not.toBeNull()
    expect(new TextDecoder().decode(await drain(out!))).toBe('%PDF-1.7\nbody more end')
  })

  it('finds the magic when it is split across chunks, one byte at a time', async () => {
    const { stream } = chunked([...'%PDF-1.4 x'].map(ch => bytes(ch)))
    const out = await pdfStreamOrNull(stream)
    expect(out).not.toBeNull()
    expect(new TextDecoder().decode(await drain(out!))).toBe('%PDF-1.4 x')
  })

  it('returns null for a body that does not start with the magic, and cancels the source', async () => {
    const { stream, state } = chunked([bytes('<html>nope'), bytes('rest')])
    expect(await pdfStreamOrNull(stream)).toBeNull()
    expect(state.cancelled).toBe(true)
  })

  it('returns null for an empty body and for one shorter than the magic', async () => {
    expect(await pdfStreamOrNull(chunked([]).stream)).toBeNull()
    expect(await pdfStreamOrNull(chunked([bytes('%PDF')]).stream)).toBeNull()
  })

  it('skips empty chunks before the magic', async () => {
    const { stream } = chunked([new Uint8Array(0), bytes('%PDF-'), bytes('x')])
    const out = await pdfStreamOrNull(stream)
    expect(out).not.toBeNull()
    expect(new TextDecoder().decode(await drain(out!))).toBe('%PDF-x')
  })

  it('does not read the rest of a large body before returning', async () => {
    // 200 chunks of 1 MB, generated lazily: reading them all would be 200 MB.
    const state = { pulled: 0 }
    const big = new Uint8Array(1024 * 1024)
    big.set(bytes('%PDF-'), 0)
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (state.pulled >= 200) return controller.close()
        controller.enqueue(state.pulled === 0 ? big : new Uint8Array(1024 * 1024))
        state.pulled++
      },
    }, { highWaterMark: 0 })
    const out = await pdfStreamOrNull(stream)
    expect(out).not.toBeNull()
    expect(state.pulled).toBeLessThanOrEqual(2)
    // And it keeps streaming: reading one more chunk pulls one more, not the rest.
    const reader = out!.getReader()
    await reader.read()
    await reader.read()
    expect(state.pulled).toBeLessThanOrEqual(4)
    await reader.cancel()
  })

  it('passes a source error through to the reader', async () => {
    let n = 0
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (n++ === 0) controller.enqueue(bytes('%PDF-1'))
        else controller.error(new Error('r2 went away'))
      },
    })
    const out = await pdfStreamOrNull(stream)
    await expect(drain(out!)).rejects.toThrow('r2 went away')
  })

  it('cancelling the returned stream cancels the source', async () => {
    const { stream, state } = chunked([bytes('%PDF-1'), bytes('more')])
    const out = await pdfStreamOrNull(stream)
    await out!.cancel()
    expect(state.cancelled).toBe(true)
  })
})

describe('startsWithPdfMagic', () => {
  it('is true for bytes that start with %PDF-', () => {
    expect(startsWithPdfMagic(bytes('%PDF-1.7\nbody'))).toBe(true)
  })

  it('is true for exactly the five magic bytes', () => {
    expect(startsWithPdfMagic(bytes('%PDF-'))).toBe(true)
  })

  it('is false for an empty body and for one shorter than the magic', () => {
    expect(startsWithPdfMagic(new Uint8Array(0))).toBe(false)
    expect(startsWithPdfMagic(bytes('%'))).toBe(false)
    expect(startsWithPdfMagic(bytes('%PDF'))).toBe(false)
  })

  it.each([
    ['an HTML page', '<html><body>503</body></html>'],
    ['the magic without its dash', '%PDF1.7\n'],
    ['a lowercase magic', '%pdf-1.7'],
    ['whitespace before the magic', ' %PDF-1.7'],
    ['a newline before the magic', '\n%PDF-1.7'],
    ['the magic later in the body', '<p>%PDF-1.7</p>'],
    ['a near miss in the last byte', '%PDF+'],
  ])('is false for %s', (_label, body) => {
    expect(startsWithPdfMagic(bytes(body))).toBe(false)
  })

  it('is false for a byte order mark before the magic', () => {
    expect(startsWithPdfMagic(Uint8Array.from([0xef, 0xbb, 0xbf, ...bytes('%PDF-')]))).toBe(false)
  })

  it('reads a view of a larger buffer from the view\'s own start', () => {
    const buf = new Uint8Array([...bytes('xx%PDF-1.7')])
    expect(startsWithPdfMagic(buf.subarray(2))).toBe(true)
    expect(startsWithPdfMagic(buf.subarray(1))).toBe(false)
    expect(startsWithPdfMagic(buf)).toBe(false)
  })

  it('does not read past the first five bytes of a large body', () => {
    const big = new Uint8Array(4 * 1024 * 1024)
    big.set(bytes('%PDF-'), 0)
    expect(startsWithPdfMagic(big)).toBe(true)
    big[4] = 0
    expect(startsWithPdfMagic(big)).toBe(false)
  })
})
