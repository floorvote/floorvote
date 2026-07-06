import { describe, it, expect, beforeEach, vi } from 'vitest'
import { safeFetch, SsrfError, readCappedBody } from '../../src/lib/safeFetch'
import { isSafeFetchUrl } from '../../src/lib/safeUrl'

function resp(status: number, headers: Record<string, string> = {}, body = 'ok'): Response {
  return new Response(body, { status, headers })
}

beforeEach(() => vi.restoreAllMocks())

describe('isSafeFetchUrl', () => {
  it('allows public http and https hosts (state legislature links may be http)', () => {
    expect(isSafeFetchUrl('https://leg.state.gov/bill.pdf')).toBe(true)
    expect(isSafeFetchUrl('http://www.legislature.gov/x')).toBe(true)
  })

  it('blocks private/loopback/IP/bare hosts and non-http schemes', () => {
    for (const u of [
      'http://127.0.0.1/x',
      'https://localhost/x',
      'http://169.254.169.254/latest/meta-data',
      'https://[::1]/',
      'https://10.0.0.5/',
      'https://192.168.1.1/',
      'https://internal/x',
      'https://foo.local/x',
      'https://localhost./x',
      'ftp://x.com/x',
      'file:///etc/passwd',
    ]) {
      expect(isSafeFetchUrl(u), u).toBe(false)
    }
  })
})

describe('safeFetch — M1 SSRF guard', () => {
  it('fetches a safe URL with manual redirect and returns the response', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(resp(200))
    const r = await safeFetch('https://leg.state.gov/bill.pdf')
    expect(r.status).toBe(200)
    expect(spy).toHaveBeenCalledOnce()
    expect((spy.mock.calls[0][1] as RequestInit).redirect).toBe('manual')
  })

  it('throws SsrfError for an unsafe initial URL without fetching', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(resp(200))
    await expect(safeFetch('http://169.254.169.254/latest/meta-data')).rejects.toBeInstanceOf(SsrfError)
    expect(spy).not.toHaveBeenCalled()
  })

  it('follows a redirect to another safe URL', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(resp(302, { location: 'https://cdn.leg.gov/final.pdf' }))
      .mockResolvedValueOnce(resp(200))
    const r = await safeFetch('https://leg.state.gov/bill.pdf')
    expect(r.status).toBe(200)
    expect(spy).toHaveBeenCalledTimes(2)
  })

  it('blocks a redirect that points at an internal address', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(resp(302, { location: 'http://169.254.169.254/' }))
    await expect(safeFetch('https://leg.state.gov/bill.pdf')).rejects.toBeInstanceOf(SsrfError)
    expect(spy).toHaveBeenCalledOnce() // never fetched the internal target
  })

  it('throws on too many redirects', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(resp(302, { location: 'https://leg.state.gov/again' }))
    await expect(safeFetch('https://leg.state.gov/start')).rejects.toBeInstanceOf(SsrfError)
  })

  it('rejects an over-size response by Content-Length', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(resp(200, { 'content-length': String(26 * 1024 * 1024) }))
    await expect(safeFetch('https://leg.state.gov/huge.pdf')).rejects.toBeInstanceOf(SsrfError)
  })

  it('blocks a scheme-relative redirect to an internal host', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(resp(302, { location: '//169.254.169.254/' }))
    await expect(safeFetch('https://leg.state.gov/bill.pdf')).rejects.toBeInstanceOf(SsrfError)
    expect(spy).toHaveBeenCalledOnce()
  })

  it('returns a 3xx without a Location as-is (no redirect-budget burn)', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(resp(302)) // 302, no Location header
    const r = await safeFetch('https://leg.state.gov/bill.pdf')
    expect(r.status).toBe(302)
    expect(spy).toHaveBeenCalledOnce()
  })
})

describe('readCappedBody', () => {
  it('throws SsrfError when the streamed body exceeds the cap (no Content-Length needed)', async () => {
    const chunk = new Uint8Array(100)
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(chunk)
        c.enqueue(chunk)
        c.close()
      },
    })
    await expect(readCappedBody(new Response(stream), 150)).rejects.toBeInstanceOf(SsrfError)
  })

  it('returns the full body when under the cap', async () => {
    const out = await readCappedBody(new Response(new Uint8Array([1, 2, 3])), 1024)
    expect(out.byteLength).toBe(3)
  })
})
