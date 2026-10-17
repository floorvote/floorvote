import { Unzip, UnzipInflate, type UnzipFile } from 'fflate'

/**
 * Reads a zip from a `fetch` response as a stream, one entry at a time, and
 * never the whole zip in memory. GovInfo's 119th Congress zips run to 33 MB
 * compressed and 150 MB of XML, against a Worker's 128 MB.
 *
 * Only the entry being read is held, in pieces as it inflates, and handed to
 * `onEntry` whole once it is complete. An entry larger than `maxEntryBytes`
 * stops the read, so a zip can't make the reader hold more than that.
 *
 * Fails closed. Everything the reader can tell is wrong about a download
 * throws, so the caller writes nothing from it:
 * - an HTTP answer other than 200;
 * - a body that doesn't start like a zip (a web page answered with 200);
 * - a body shorter or longer than the length it announced;
 * - a zip cut off anywhere: `Unzip` alone reads a zip cut between two entries,
 *   or in its central directory, as a smaller zip, so the reader also requires
 *   the end-of-central-directory record, which is the last thing in a complete
 *   zip, and checks it against what it read: its entry count, and where the
 *   central directory sits;
 * - deflated data that doesn't inflate.
 * An error from `onEntry` stops the read and is thrown as it is.
 */

/** The most an entry may inflate to. The largest of the 19,690 119th Congress files is 2.5 MB of XML. */
export const MAX_ENTRY_BYTES = 16 * 1024 * 1024

/**
 * fflate's streaming `Unzip` finds the end of an entry that carries a data
 * descriptor (as GovInfo's do) by scanning for the next header, and loses the
 * last entry when it is pushed fewer than 4 bytes at a time. A body is cut
 * into chunks however the network pleases, so pushes are gathered to at least
 * this many bytes first.
 */
const MIN_PUSH_BYTES = 1024

/** The end-of-central-directory record is 22 bytes, then a comment of up to 65,535. */
const EOCD_SIZE = 22
const TAIL_BYTES = EOCD_SIZE + 0xFFFF

const LOCAL_HEADER = [0x50, 0x4B, 0x03, 0x04]
const EOCD_SIGNATURE = [0x50, 0x4B, 0x05, 0x06]

/** A reason a download isn't a complete zip. Its message always says ZIP. */
export class ZipError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ZipError'
  }
}

export interface ZipSummary {
  /** Entries handed to `onEntry`, directories left out. */
  entries: number
  /** Bytes of the zip read. */
  bytes: number
}

const startsWith = (bytes: Uint8Array, at: number, signature: readonly number[]) => signature.every((b, k) => bytes[at + k] === b)

export async function readZip(
  res: Response,
  onEntry: (name: string, data: Uint8Array) => void | Promise<void>,
  opts: { maxEntryBytes?: number } = {},
): Promise<ZipSummary> {
  const max = opts.maxEntryBytes ?? MAX_ENTRY_BYTES
  if (res.status !== 200) {
    await res.body?.cancel().catch(() => {})
    throw new ZipError(`ZIP download answered HTTP ${res.status}`)
  }
  if (!res.body) throw new ZipError('ZIP download had no body')
  // A body a proxy compressed has no length to check.
  const announced = res.headers.has('content-encoding') ? null : Number(res.headers.get('content-length') ?? NaN)
  const reader = res.body.getReader()

  let zipError: ZipError | null = null
  let handlerError: unknown = null
  let failed = false
  let entries = 0
  /** Entries the zip held that were read to their end, directories too. */
  let seen = 0
  const completed: { name: string; data: Uint8Array }[] = []

  const unzip = new Unzip((file: UnzipFile) => {
    // Every entry is started, so fflate never holds the bytes of one it hasn't been asked to read.
    const name = file.name
    const parts: Uint8Array[] = []
    let size = 0
    let tooLarge = false
    file.ondata = (err, chunk, final) => {
      if (err) { zipError ??= new ZipError(`ZIP entry ${name} is damaged: ${err.message}`); return }
      if (tooLarge) return
      size += chunk.length
      if (size > max) {
        tooLarge = true
        parts.length = 0
        zipError ??= new ZipError(`ZIP entry ${name} is too large (over ${max} bytes)`)
        file.terminate()
        return
      }
      parts.push(chunk)
      if (final) {
        seen++
        if (name.endsWith('/')) return
        completed.push({ name, data: concat(parts, size) })
      }
    }
    file.start()
  })
  unzip.register(UnzipInflate)

  /** Hand over each entry completed so far, one at a time. */
  const drain = async () => {
    while (completed.length > 0) {
      const entry = completed.shift()!
      try {
        await onEntry(entry.name, entry.data)
        entries++
      } catch (err) {
        handlerError = err
        failed = true
        return
      }
    }
  }

  const tail: Uint8Array[] = []
  let tailLength = 0
  let received = 0
  let head = new Uint8Array(0)
  let checkedHead = false
  /** Chunks read and not yet pushed to the unzip. */
  const waiting: Uint8Array[] = []
  let waitingLength = 0

  const abort = async (): Promise<never> => {
    await reader.cancel().catch(() => {})
    if (handlerError !== null) throw handlerError
    throw zipError ?? new ZipError('ZIP read failed')
  }

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (value && value.length > 0) {
        received += value.length
        tail.push(value)
        tailLength += value.length
        while (tail.length > 1 && tailLength - tail[0].length >= TAIL_BYTES) tailLength -= tail.shift()!.length

        if (checkedHead) {
          waiting.push(value)
          waitingLength += value.length
        } else {
          head = head.length === 0 ? value : concat([head, value], head.length + value.length)
          if (head.length >= 4) {
            checkedHead = true
            checkHead(head)
            waiting.push(head)
            waitingLength += head.length
          }
        }
      }
      if (checkedHead && waitingLength > 0 && (waitingLength >= MIN_PUSH_BYTES || done)) {
        unzip.push(concat(waiting, waitingLength))
        waiting.length = 0
        waitingLength = 0
        if (zipError || handlerError !== null) failed = true
        if (!failed) await drain()
        if (failed || zipError) return await abort()
      }
      if (done) break
    }
    if (!checkedHead) checkHead(head)
    unzip.push(new Uint8Array(0), true)
    if (zipError) return await abort()
    await drain()
    if (failed) return await abort()
  } catch (err) {
    if (err === handlerError || err instanceof ZipError) throw err
    await reader.cancel().catch(() => {})
    // Anything else is fflate telling us the zip is damaged.
    throw new ZipError(`ZIP is damaged: ${err instanceof Error ? err.message : String(err)}`)
  }

  if (announced !== null && Number.isFinite(announced) && received !== announced) {
    throw new ZipError(`ZIP download is ${received} bytes, not the ${announced} it announced`)
  }
  verifyEnd(concat(tail, tailLength), received, seen)
  return { entries, bytes: received }
}

/** A zip starts with a local file header, or, with no entries at all, with its end record. */
function checkHead(head: Uint8Array): void {
  if (head.length >= 4 && (startsWith(head, 0, LOCAL_HEADER) || startsWith(head, 0, EOCD_SIGNATURE))) return
  throw new ZipError('the download isn\'t a ZIP archive')
}

/**
 * The last thing in a complete zip is its end-of-central-directory record.
 * Require it, with a comment as long as the bytes after it, and check what it
 * says against what was read: the number of entries, and that the central
 * directory sits where the record says, ending where the record begins.
 */
function verifyEnd(tail: Uint8Array, received: number, seen: number): void {
  const incomplete = (why: string) => new ZipError(`ZIP is incomplete: ${why}`)
  const view = new DataView(tail.buffer, tail.byteOffset, tail.byteLength)
  for (let at = tail.length - EOCD_SIZE; at >= 0; at--) {
    if (!startsWith(tail, at, EOCD_SIGNATURE)) continue
    const comment = view.getUint16(at + 20, true)
    if (at + EOCD_SIZE + comment !== tail.length) continue
    const count = view.getUint16(at + 10, true)
    // 0xFFFF and 0xFFFFFFFF mean ZIP64, whose real values sit in a record this doesn't read.
    if (count !== 0xFFFF && count !== seen) throw incomplete(`its directory lists ${count} entries and ${seen} were read`)
    const size = view.getUint32(at + 12, true)
    const offset = view.getUint32(at + 16, true)
    const recordStart = received - (tail.length - at)
    if (size !== 0xFFFFFFFF && offset !== 0xFFFFFFFF && offset + size !== recordStart) {
      throw incomplete('its directory isn\'t where its end record says')
    }
    return
  }
  throw incomplete('it has no end record')
}

function concat(parts: readonly Uint8Array[], length: number): Uint8Array {
  if (parts.length === 1) return parts[0]
  const out = new Uint8Array(length)
  let at = 0
  for (const p of parts) { out.set(p, at); at += p.length }
  return out
}
