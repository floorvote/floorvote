import { describe, it, expect, vi } from 'vitest'
import { sendFeedback } from '../../src/lib/email'

describe('sendFeedback with no operator contacts', () => {
  it('throws and never calls the provider when OPERATOR_CONTACT_EMAILS is empty', async () => {
    const send = vi.fn()
    const env = { EMAIL_PROVIDER: 'cloudflare' as const, EMAIL: { send }, OPERATOR_CONTACT_EMAILS: '' }
    await expect(
      sendFeedback({ email: 'user@example.com' }, 'hi', undefined, env as never),
    ).rejects.toThrow(/not configured|empty/i)
    expect(send).not.toHaveBeenCalled()
  })
})
