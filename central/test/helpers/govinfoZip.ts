import { deflateSync } from 'fflate'

/**
 * Test helpers for the GovInfo provider: zips shaped the way GovInfo builds its
 * Bill Status bulk files, and responses that serve them the way a network
 * does, a piece at a time.
 *
 * GovInfo's zips hold one deflated XML file per bill, each written with a data
 * descriptor after its data (the local header carries no sizes), and a central
 * directory at the end. `fflate`'s own `zipSync` writes sizes into the local
 * headers instead, which isn't the shape the provider has to read.
 */

const enc = new TextEncoder()

export interface ZipEntry { name: string; data: Uint8Array | string }

/** The CRC-32 of some bytes, as a zip stores it. */
function crc32(bytes: Uint8Array): number {
  let crc = ~0
  for (const b of bytes) {
    crc ^= b
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xEDB88320 & -(crc & 1))
  }
  return ~crc >>> 0
}

/** A zip with a data descriptor after every entry, as GovInfo writes them. */
export function buildZip(entries: readonly ZipEntry[]): Uint8Array {
  const parts: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0
  const push = (bytes: Uint8Array) => { parts.push(bytes); offset += bytes.length }
  // 2026-10-17 00:19:30, as DOS date and time.
  const dosTime = (0 << 11) | (19 << 5) | (30 >> 1)
  const dosDate = ((2026 - 1980) << 9) | (10 << 5) | 17

  for (const entry of entries) {
    const name = enc.encode(entry.name)
    const raw = typeof entry.data === 'string' ? enc.encode(entry.data) : entry.data
    const packed = deflateSync(raw)
    const crc = crc32(raw)
    const localOffset = offset

    const local = new DataView(new ArrayBuffer(30))
    local.setUint32(0, 0x04034B50, true)
    local.setUint16(4, 20, true)
    local.setUint16(6, 0x0008, true) // bit 3: sizes and CRC follow the data
    local.setUint16(8, 8, true) // deflate
    local.setUint16(10, dosTime, true)
    local.setUint16(12, dosDate, true)
    local.setUint16(26, name.length, true)
    push(new Uint8Array(local.buffer)); push(name); push(packed)

    const descriptor = new DataView(new ArrayBuffer(16))
    descriptor.setUint32(0, 0x08074B50, true)
    descriptor.setUint32(4, crc, true)
    descriptor.setUint32(8, packed.length, true)
    descriptor.setUint32(12, raw.length, true)
    push(new Uint8Array(descriptor.buffer))

    const cd = new DataView(new ArrayBuffer(46))
    cd.setUint32(0, 0x02014B50, true)
    cd.setUint16(4, 20, true)
    cd.setUint16(6, 20, true)
    cd.setUint16(8, 0x0008, true)
    cd.setUint16(10, 8, true)
    cd.setUint16(12, dosTime, true)
    cd.setUint16(14, dosDate, true)
    cd.setUint32(16, crc, true)
    cd.setUint32(20, packed.length, true)
    cd.setUint32(24, raw.length, true)
    cd.setUint16(28, name.length, true)
    cd.setUint32(42, localOffset, true)
    central.push(new Uint8Array(cd.buffer), name)
  }

  const cdStart = offset
  for (const c of central) push(c)
  const eocd = new DataView(new ArrayBuffer(22))
  eocd.setUint32(0, 0x06054B50, true)
  eocd.setUint16(8, entries.length, true)
  eocd.setUint16(10, entries.length, true)
  eocd.setUint32(12, offset - cdStart, true)
  eocd.setUint32(16, cdStart, true)
  push(new Uint8Array(eocd.buffer))

  const out = new Uint8Array(offset)
  let at = 0
  for (const p of parts) { out.set(p, at); at += p.length }
  return out
}

/** Where each entry of a zip from `buildZip` starts, and where its central directory does. */
export function zipLayout(zip: Uint8Array): { entryStarts: number[]; centralDirectory: number } {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength)
  const eocd = zip.length - 22
  const count = view.getUint16(eocd + 10, true)
  const centralDirectory = view.getUint32(eocd + 16, true)
  const entryStarts: number[] = []
  let p = centralDirectory
  for (let i = 0; i < count; i++) {
    entryStarts.push(view.getUint32(p + 42, true))
    p += 46 + view.getUint16(p + 28, true) + view.getUint16(p + 30, true) + view.getUint16(p + 32, true)
  }
  return { entryStarts, centralDirectory }
}

export interface ServedZip {
  response: Response
  /** Bytes of the body the reader has pulled so far. */
  pulled: () => number
}

/**
 * A response whose body is served `chunkSize` bytes at a time, only as the
 * reader asks for more, with every way of reading the whole body at once
 * (`arrayBuffer`, `text`, `blob`, `bytes`, `json`, `formData`) made to throw.
 * A provider that buffers a zip whole can't read one of these.
 */
export function serveZip(
  bytes: Uint8Array,
  opts: { chunkSize?: number; headers?: Record<string, string>; status?: number; contentLength?: number | null } = {},
): ServedZip {
  const chunkSize = opts.chunkSize ?? 4096
  let pos = 0
  // A high-water mark of 0 means nothing is read ahead: a chunk is cut only when the reader asks for it.
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pos >= bytes.length) { controller.close(); return }
      controller.enqueue(bytes.slice(pos, pos + chunkSize))
      pos += chunkSize
    },
  }, { highWaterMark: 0 })
  const headers: Record<string, string> = {
    'content-type': 'application/zip',
    'last-modified': 'Sat, 17 Oct 2026 00:19:30 GMT',
    ...(opts.contentLength === null ? {} : { 'content-length': String(opts.contentLength ?? bytes.length) }),
    ...opts.headers,
  }
  const response = new Response(body, { status: opts.status ?? 200, headers })
  for (const method of ['arrayBuffer', 'text', 'blob', 'bytes', 'json', 'formData'] as const) {
    Object.defineProperty(response, method, {
      value: () => { throw new Error(`the zip was read whole with ${method}()`) },
    })
  }
  return { response, pulled: () => Math.min(pos, bytes.length) }
}

/** Every Bill Status file recorded under test/fixtures/govinfo, by file name, as text. */
const files = import.meta.glob('../fixtures/govinfo/BILLSTATUS-*.xml', { query: '?raw', import: 'default', eager: true }) as Record<string, string>
export const fixtureFiles: ReadonlyMap<string, string> = new Map(
  Object.entries(files).map(([path, xml]) => [path.split('/').pop()!, xml]),
)

/** The GovInfo bill type of a Bill Status file name: `BILLSTATUS-119hjres219.xml` is `hjres`. */
export function fileType(name: string): string {
  const m = /^BILLSTATUS-\d+([a-z]+)\d+\.xml$/.exec(name)
  if (!m) throw new Error(`not a Bill Status file name: ${name}`)
  return m[1]
}

/** The eight GovInfo bill types, in the order the provider reads them. */
export const BILL_TYPES = ['hr', 's', 'hres', 'sres', 'hjres', 'sjres', 'hconres', 'sconres'] as const

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** A time as GovInfo's bulk listing writes it, in UTC to the minute: `2026-07-18T23:27:41Z` is `18-Jul-2026 23:27`. */
export function listingTime(iso: string): string {
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getUTCDate())}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
}

/**
 * GovInfo's bulk listing of one bill type's folder, as
 * `/bulkdata/json/BILLSTATUS/<congress>/<type>` answers it with
 * `Accept: application/json`: every Bill Status file of the type with the time
 * it last changed, and the type's zip with the time it was built. The shape is
 * a real answer's, recorded on October 18, 2026.
 */
export function buildListing(
  congress: number,
  type: string,
  files: Iterable<[name: string, modified: string]>,
  zipModified: string | null = '2026-10-17T00:19:30Z',
): string {
  const entry = (name: string, ext: string, modified: string, size: number) => ({
    displayLabel: name,
    fileExtension: ext,
    folder: false,
    formattedLastModifiedTime: listingTime(modified),
    formattedSize: `${(size / 1024).toFixed(1)} KB`,
    justFileName: name,
    link: `https://www.govinfo.gov/bulkdata/BILLSTATUS/${congress}/${type}/${name}`,
    mimeType: ext === 'zip' ? 'application/zip' : 'application/xml',
    name,
    size,
  })
  const out = [...files].map(([name, modified]) => entry(name, 'xml', modified, 9000))
  if (zipModified) out.push(entry(`BILLSTATUS-${congress}-${type}.zip`, 'zip', zipModified, 200000))
  return JSON.stringify({ files: out })
}

/** A type's bulk listing address: `https://www.govinfo.gov/bulkdata/json/BILLSTATUS/119/hr`. */
export const LISTING_URL = /^https:\/\/www\.govinfo\.gov\/bulkdata\/json\/BILLSTATUS\/(\d+)\/([a-z]+)$/

/**
 * What the stubbed GovInfo answers for a listing of these files, or null when
 * the address isn't a listing. Each file is listed as changed at
 * `modified(name, data)`, and the zip at `zipModified`.
 */
export function listingResponse(
  url: string,
  files: ReadonlyMap<string, string>,
  modified: (name: string, data: string) => string,
  zipModified: string | null = '2026-10-17T00:19:30Z',
): Response | null {
  const m = LISTING_URL.exec(url)
  if (!m || !(BILL_TYPES as readonly string[]).includes(m[2])) return null
  const congress = Number(m[1])
  const of = [...files].filter(([name]) => name.startsWith(`BILLSTATUS-${congress}`) && fileType(name) === m[2])
  return new Response(buildListing(congress, m[2], of.map(([name, data]): [string, string] => [name, modified(name, data)]), zipModified),
    { headers: { 'content-type': 'application/json' } })
}
