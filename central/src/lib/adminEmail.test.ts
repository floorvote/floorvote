import { describe, it, expect } from 'vitest'
import { sendAdminMagicLink } from './adminEmail'

describe('sendAdminMagicLink', () => {
  it('puts the sign-in URL in the text part without referencing a (nonexistent) button', async () => {
    const sent: Record<string, unknown>[] = []
    const env = {
      EMAIL_PROVIDER: 'cloudflare' as const,
      EMAIL: { send: async (m: Record<string, unknown>) => { sent.push(m); return { messageId: 'm' } } },
    }
    await sendAdminMagicLink('admin@b.com', 'https://admin.test/auth?token=abc', env as never)
    const text = String(sent[0].text)
    expect(text).toContain('https://admin.test/auth?token=abc')
    expect(text.toLowerCase()).not.toContain('button')
  })
})
