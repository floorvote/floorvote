import { describe, it, expect } from 'vitest'
import { unsubscribeHeaders } from '../../src/lib/email'

// The sender's behavior (defaults, headers, fallback, batches, demo mode, the
// From address) is tested in shared/emailSender.test.ts against in-memory
// providers, and the adapters in shared/emailProviders.test.ts. The API's
// wiring of the sender is in signInEmail.test.ts, operatorEmailSend.test.ts,
// emailSendStats.test.ts, and bulkEmailSend.test.ts. What is left here is the
// API's own email helpers.

describe('unsubscribeHeaders', () => {
  it('builds an RFC-2369 List-Unsubscribe header pointing at the /profile setting anchor', () => {
    expect(unsubscribeHeaders('https://ri.example.com', 'setting-email-digest')).toEqual({
      'List-Unsubscribe': '<https://ri.example.com/profile#setting-email-digest>',
    })
  })
})
