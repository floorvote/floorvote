import { isSafeFetchUrl } from './safeUrl'

const MAX_REDIRECTS = 3
const MAX_BYTES = 25 * 1024 * 1024 // 25 MB ceiling for a single bill text / PDF

export class SsrfError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SsrfError'
  }
}

/**
 * SSRF-guarded fetch for provider-supplied document URLs (finding M1).
 *
 * Central downloads bill text from URLs that LegiScan / OpenStates return
 * (`state_link`, version `links[].url`). Those upstreams are first-party-trusted,
 * but the link fields are attacker-influenceable in principle, so before — and
 * on every redirect hop — we enforce:
 *   - http/https scheme and a PUBLIC host (no localhost / `.local` / bare host /
 *     raw IP literal), so the fetch can't be pointed at an internal address;
 *   - a bounded redirect count, following manually so each hop is re-validated
 *     (a public URL can't 30x-redirect into the internal network);
 *   - a response-size ceiling via Content-Length.
 *
 * Throws `SsrfError` if any URL in the chain is unsafe, the chain is too long,
 * or the response is over the size ceiling. Callers already wrap text downloads
 * in try/catch, so a throw cleanly skips that download.
 */
/**
 * Read a response body into memory with a hard byte ceiling, aborting the stream
 * the moment it is exceeded. Enforces the size cap even when the server omits
 * Content-Length (chunked / streaming responses). Exported for testing.
 */
export async function readCappedBody(res: Response, maxBytes: number): Promise<Uint8Array> {
  if (!res.body) return new Uint8Array(0)
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => {})
      throw new SsrfError(`response exceeded ${maxBytes} bytes`)
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.byteLength
  }
  return out
}

export async function safeFetch(url: string, init?: RequestInit): Promise<Response> {
  let current = url
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!isSafeFetchUrl(current)) {
      throw new SsrfError(`blocked unsafe fetch URL: ${current}`)
    }
    const res = await fetch(current, { ...init, redirect: 'manual' })
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location')
      if (!location) return res // 3xx without a usable Location — hand back as-is
      try {
        // Resolve relative redirects against the current URL; re-validated next loop.
        current = new URL(location, current).toString()
      } catch {
        throw new SsrfError(`malformed redirect Location: ${location}`)
      }
      continue
    }
    // Size ceiling: fast-reject on a declared-too-large Content-Length, then
    // enforce for real by reading the body with a byte cap (Content-Length may be
    // absent on a chunked response). Reconstruct a Response so callers still read
    // .ok / headers / text() / arrayBuffer() normally.
    const lenHeader = res.headers.get('content-length')
    if (lenHeader !== null) {
      const len = Number(lenHeader)
      if (Number.isFinite(len) && len > MAX_BYTES) {
        throw new SsrfError(`response too large: ${len} bytes`)
      }
    }
    const body = await readCappedBody(res, MAX_BYTES)
    return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers })
  }
  throw new SsrfError('too many redirects')
}
