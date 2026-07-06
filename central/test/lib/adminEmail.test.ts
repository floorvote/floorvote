import { describe, it, expect, vi, beforeEach } from 'vitest'
import { sendAdminMagicLink } from '../../src/lib/adminEmail'

const RESEND_OK = { ok: true, status: 200, text: () => Promise.resolve('') } as Response

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('sendAdminMagicLink', () => {
  it('POSTs to Resend with bearer auth and includes the link in the body', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(RESEND_OK)
    await sendAdminMagicLink('admin@example.com', 'https://admin.example.com/auth/callback?token=abc', { RESEND_API_KEY: 'rk_test' })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.resend.com/emails')
    const headers = init.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer rk_test')
    const body = JSON.parse(init.body as string)
    expect(body.to).toEqual(['admin@example.com'])
    expect(body.html).toContain('https://admin.example.com/auth/callback?token=abc')
    expect(body.subject).toContain('admin')
  })

  it('throws on non-2xx', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, status: 500, text: () => Promise.resolve('boom') } as Response)
    await expect(
      sendAdminMagicLink('admin@example.com', 'https://x', { RESEND_API_KEY: 'rk_test' })
    ).rejects.toThrow('Email send failed (resend): 500')
  })
})
