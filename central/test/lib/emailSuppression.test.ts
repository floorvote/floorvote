import { describe, it, expect, vi, afterEach } from 'vitest'
import { checkEmailSuppression, checkEmailSuppressions } from '../../src/lib/emailSuppression'

const creds = { CF_EMAIL_TOKEN: 'tok', CF_ACCOUNT_ID: 'acct' }
afterEach(() => vi.restoreAllMocks())

describe('checkEmailSuppression', () => {
  it('returns suppressed:null when creds are missing', async () => {
    expect(await checkEmailSuppression({}, 'a@b.com')).toEqual({ suppressed: null })
  })
  it('returns suppressed:true with reason when the address is on the list', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      total: 1, result: [{ email: 'a@b.com', reason: 'hard_bounce', created_at: '2026-06-20T00:00:00Z' }],
    }), { status: 200 })))
    expect(await checkEmailSuppression(creds, 'A@B.com')).toEqual({ suppressed: true, reason: 'hard_bounce', createdAt: '2026-06-20T00:00:00Z' })
  })
  it('returns suppressed:false when absent and the list fits one page', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ total: 1, result: [{ email: 'x@y.com' }] }), { status: 200 })))
    expect(await checkEmailSuppression(creds, 'a@b.com')).toEqual({ suppressed: false })
  })
  it('returns suppressed:null when the list exceeds one page (partial scan)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ total: 2000, result: [{ email: 'x@y.com' }] }), { status: 200 })))
    expect(await checkEmailSuppression(creds, 'a@b.com')).toEqual({ suppressed: null })
  })
})

describe('checkEmailSuppressions', () => {
  const listed = (total: number, result: Array<{ email: string; reason?: string; created_at?: string }>) =>
    vi.fn().mockResolvedValue(new Response(JSON.stringify({ total, result }), { status: 200 }))

  it('checks every address with one fetch and keys results by normalized address', async () => {
    const fetchMock = listed(2, [
      { email: 'Bounced@Example.com', reason: 'hard_bounce', created_at: '2026-06-20T00:00:00Z' },
      { email: 'other@example.com' },
    ])
    vi.stubGlobal('fetch', fetchMock)
    const out = await checkEmailSuppressions(creds, [' BOUNCED@example.com ', 'clean@example.com', 'clean@example.com'])
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(out).toEqual({
      'bounced@example.com': { suppressed: true, reason: 'hard_bounce', createdAt: '2026-06-20T00:00:00Z' },
      'clean@example.com': { suppressed: false },
    })
  })

  it('returns an empty result without fetching for no addresses', async () => {
    const fetchMock = listed(0, [])
    vi.stubGlobal('fetch', fetchMock)
    expect(await checkEmailSuppressions(creds, [])).toEqual({})
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns unknown for every address when creds are missing', async () => {
    expect(await checkEmailSuppressions({}, ['a@example.com', 'b@example.com'])).toEqual({
      'a@example.com': { suppressed: null },
      'b@example.com': { suppressed: null },
    })
  })

  it('returns unknown for every address when the API errors or the fetch throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 500 })))
    expect(await checkEmailSuppressions(creds, ['a@example.com'])).toEqual({ 'a@example.com': { suppressed: null } })
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network')))
    expect(await checkEmailSuppressions(creds, ['a@example.com'])).toEqual({ 'a@example.com': { suppressed: null } })
  })

  it('still reports a listed address when the list exceeds one page, and unknown for the rest', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubGlobal('fetch', listed(2000, [{ email: 'a@example.com', reason: 'hard_bounce' }]))
    expect(await checkEmailSuppressions(creds, ['a@example.com', 'b@example.com'])).toEqual({
      'a@example.com': { suppressed: true, reason: 'hard_bounce' },
      'b@example.com': { suppressed: null },
    })
  })
})
