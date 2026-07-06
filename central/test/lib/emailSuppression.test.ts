import { describe, it, expect, vi, afterEach } from 'vitest'
import { checkEmailSuppression } from '../../src/lib/emailSuppression'

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
