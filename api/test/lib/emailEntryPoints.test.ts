import { describe, it, expect, vi, afterEach } from 'vitest'
import * as email from '../../src/lib/email'
import * as emailErrors from '../../src/lib/emailErrors'
import * as emailStats from '../../src/lib/emailStats'
import { describeSendFailure, logSendFailure } from '../../src/lib/emailErrors'

// #711 deleted what the purposes replaced. Types can't be checked at run time
// (typecheck covers them: nothing may still import `EmailMessage`, `SendOptions`,
// or `EmailSendResult`), but the functions can, so a revert fails here.

describe('the old send entry points are gone', () => {
  it.each(['sendEmail', 'sendBatch', 'sendMagicLink', 'sendFeedback', 'activeProvider', 'otherProvider'])(
    'the email module no longer exports %s', (name) => {
      expect(Object.keys(email)).not.toContain(name)
    },
  )

  it('keeps the one way in: senderFor, with the purpose-level sender behind it', () => {
    expect(typeof email.senderFor).toBe('function')
  })

  it('the thrown PermanentSendError is gone: a send answers with a result that says whether it was permanent', () => {
    expect(Object.keys(emailErrors)).not.toContain('PermanentSendError')
  })

  it('the substring check on one Cloudflare error code is gone: an adapter classifies its own failures', () => {
    expect(Object.keys(emailStats)).not.toContain('isRecipientError')
  })
})

describe('describeSendFailure', () => {
  it('names the provider that failed and why', () => {
    expect(describeSendFailure({ ok: false, provider: 'resend', error: '429', permanent: false, attempts: [] })).toBe('Email send failed (resend): 429')
  })

  it('gives the bare reason when no provider was tried', () => {
    expect(describeSendFailure({ ok: false, provider: null, error: 'Invalid recipient address: a@b', permanent: true, attempts: [] })).toBe('Invalid recipient address: a@b')
  })
})

describe('logSendFailure', () => {
  afterEach(() => vi.restoreAllMocks())

  it('logs a failed send as one line', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    logSendFailure({ ok: false, provider: 'cloudflare', error: 'E_RATE_LIMIT_EXCEEDED: slow down', permanent: false, attempts: [] })
    expect(err).toHaveBeenCalledOnce()
    expect(err.mock.calls[0][0]).toBe('Email send failed (cloudflare): E_RATE_LIMIT_EXCEEDED: slow down')
  })

  it('logs nothing for a send that went out, or one demo mode suppressed', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    logSendFailure({ ok: true, provider: 'resend', attempts: [] })
    logSendFailure({ ok: true, provider: null, skipped: 'demo-mode', attempts: [] })
    expect(err).not.toHaveBeenCalled()
  })
})
