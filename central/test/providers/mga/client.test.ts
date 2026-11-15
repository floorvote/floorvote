import { describe, it, expect, vi, beforeEach } from 'vitest'

// What getMgaSession makes of the session file's body. A session that has no
// bills yet is served as an empty file: `null` in some years, a bare line
// break in others (2027RS, November 2026), both with status 200 and a JSON
// content type. Either is nothing new, never a failed pass. A body that is
// neither JSON nor blank (an HTML error page) still fails closed.
let body = '[]'
let status = 200
vi.mock('../../../src/lib/rateLimitedFetch', () => ({
  rateLimitedFetch: async () => new Response(body, { status, headers: { ETag: '"e1"' } }),
}))

import { getMgaSession } from '../../../src/providers/mga/client'

beforeEach(() => { body = '[]'; status = 200 })

describe('getMgaSession and the body of the session file', () => {
  it.each([
    ['a bare CRLF', '\r\n'],
    ['a bare LF', '\n'],
    ['nothing', ''],
    ['spaces and a line break', '  \n'],
  ])('reads %s as an empty file', async (_name, blank) => {
    body = blank
    await expect(getMgaSession('2027RS')).resolves.toEqual({ unchanged: false, records: [], etag: null })
  })

  it('reads a null body as an empty file', async () => {
    body = 'null'
    await expect(getMgaSession('2027RS')).resolves.toEqual({ unchanged: false, records: [], etag: null })
  })

  it('reads an empty list as an empty file with its ETag', async () => {
    await expect(getMgaSession('2027RS')).resolves.toEqual({ unchanged: false, records: [], etag: '"e1"' })
  })

  it('fails closed on a body that is not JSON', async () => {
    body = '<html><body>Service unavailable</body></html>'
    await expect(getMgaSession('2027RS')).rejects.toThrow("MGA 2027RS: the session file isn't JSON")
  })
})
