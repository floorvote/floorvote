import { describe, it, expect } from 'vitest'
import { emailChangeReducer, CANCEL_NOTE, pillText, isEmailChangeOpen, type EmailChangeState } from './emailChangeState'

const idle: EmailChangeState = { kind: 'idle' }
const editing = (over: Partial<Extract<EmailChangeState, { kind: 'editing' }>> = {}): EmailChangeState =>
  ({ kind: 'editing', value: '', error: null, sending: false, ...over })
const pending = (over: Partial<Extract<EmailChangeState, { kind: 'pending' }>> = {}): EmailChangeState =>
  ({ kind: 'pending', to: 'new@example.org', busy: false, error: null, announce: 'sent', ...over })

describe('emailChangeReducer', () => {
  it('opens into editing with the given starting value and no error', () => {
    expect(emailChangeReducer(idle, { type: 'open', value: 'a@example.org' })).toEqual(editing({ value: 'a@example.org' }))
  })

  it('opens empty by default', () => {
    expect(emailChangeReducer(idle, { type: 'open' })).toEqual(editing())
  })

  it('typing updates the value and clears a refusal', () => {
    const s = emailChangeReducer(editing({ value: 'x', error: 'Invalid email address' }), { type: 'edit', value: 'xy' })
    expect(s).toEqual(editing({ value: 'xy' }))
  })

  it('sending marks the request in flight and clears the error', () => {
    expect(emailChangeReducer(editing({ value: 'a@b.co', error: 'old' }), { type: 'send' })).toEqual(editing({ value: 'a@b.co', sending: true }))
  })

  it('a refusal keeps the typed value, shows the message, and ends sending', () => {
    const s = emailChangeReducer(editing({ value: 'a@b.co', sending: true }), { type: 'refused', message: 'Another member already uses that address.' })
    expect(s).toEqual(editing({ value: 'a@b.co', error: 'Another member already uses that address.' }))
  })

  it('an accepted request becomes pending on the new address, with the announcement', () => {
    const s = emailChangeReducer(editing({ value: 'a@b.co', sending: true }), { type: 'sent', to: 'a@b.co', announce: 'We sent a link' })
    expect(s).toEqual(pending({ to: 'a@b.co', announce: 'We sent a link' }))
  })

  it('cancel from editing returns to idle', () => {
    expect(emailChangeReducer(editing({ value: 'a' }), { type: 'cancel' })).toEqual(idle)
  })

  it('cancel from pending returns to idle with a note that the sent link still works', () => {
    expect(emailChangeReducer(pending(), { type: 'cancel' })).toEqual({ kind: 'idle', note: CANCEL_NOTE })
    expect(CANCEL_NOTE).toBe('Cancelled here. A link already sent still works until it expires.')
  })

  it('opening over a pending change keeps track of the link still out, and cancelling then leaves the note', () => {
    const reopened = emailChangeReducer(pending({ to: 'new@example.org' }), { type: 'open', value: 'a@example.org' })
    expect(reopened).toEqual(editing({ value: 'a@example.org', linkOut: true }))
    expect(emailChangeReducer(reopened, { type: 'edit', value: 'b@example.org' })).toEqual(editing({ value: 'b@example.org', linkOut: true }))
    expect(emailChangeReducer(reopened, { type: 'cancel' })).toEqual({ kind: 'idle', note: CANCEL_NOTE })
  })

  it('opening again while the editor is already open over a pending change keeps linkOut', () => {
    const reopened = emailChangeReducer(emailChangeReducer(pending(), { type: 'open' }), { type: 'open', value: 'z@example.org' })
    expect(reopened).toEqual(editing({ value: 'z@example.org', linkOut: true }))
    expect(emailChangeReducer(reopened, { type: 'cancel' })).toEqual({ kind: 'idle', note: CANCEL_NOTE })
  })

  it('opening clears the note', () => {
    expect(emailChangeReducer({ kind: 'idle', note: CANCEL_NOTE }, { type: 'open' })).toEqual(editing())
  })

  it('resend marks the pill busy, and a resend failure keeps it pending with the message', () => {
    const busy = emailChangeReducer(pending({ error: 'old' }), { type: 'resend' })
    expect(busy).toEqual(pending({ busy: true }))
    expect(emailChangeReducer(busy, { type: 'resendFailed', message: 'Too many.' })).toEqual(pending({ error: 'Too many.' }))
  })

  it('a successful resend stays pending with a fresh announcement', () => {
    const s = emailChangeReducer(pending({ busy: true }), { type: 'resent', announce: 'Sent again' })
    expect(s).toEqual(pending({ announce: 'Sent again' }))
  })

  it('confirmation moves a pending change to confirmed, and also lands from idle', () => {
    expect(emailChangeReducer(pending(), { type: 'confirmed', email: 'new@example.org' })).toEqual({ kind: 'confirmed', email: 'new@example.org' })
    expect(emailChangeReducer(idle, { type: 'confirmed', email: 'n@example.org' })).toEqual({ kind: 'confirmed', email: 'n@example.org' })
  })

  it('opening again from confirmed starts a fresh edit', () => {
    expect(emailChangeReducer({ kind: 'confirmed', email: 'n@example.org' }, { type: 'open' })).toEqual(editing())
  })

  it('ignores actions that make no sense in the current state', () => {
    expect(emailChangeReducer(idle, { type: 'send' })).toBe(idle)
    expect(emailChangeReducer(idle, { type: 'refused', message: 'x' })).toBe(idle)
    expect(emailChangeReducer(pending(), { type: 'edit', value: 'z' })).toEqual(pending())
    expect(emailChangeReducer(editing(), { type: 'resend' })).toEqual(editing())
  })

  it('does not reopen while a request is in flight', () => {
    const s = editing({ sending: true })
    expect(emailChangeReducer(s, { type: 'open' })).toBe(s)
  })
})

describe('pillText and isEmailChangeOpen', () => {
  it('reads the short pill copy for pending and confirmed', () => {
    expect(pillText(pending({ to: 'new@example.org' }))).toBe('→ new@example.org · Link sent')
    expect(pillText({ kind: 'confirmed', email: 'n@example.org' })).toBe('✓ Changed today')
  })

  it('has no pill for idle or editing', () => {
    expect(pillText(idle)).toBeNull()
    expect(pillText(editing())).toBeNull()
  })

  it('reports whether the row is taken up by an edit or a pending change', () => {
    expect(isEmailChangeOpen(idle)).toBe(false)
    expect(isEmailChangeOpen(editing())).toBe(true)
    expect(isEmailChangeOpen(pending())).toBe(true)
    expect(isEmailChangeOpen({ kind: 'confirmed', email: 'a@b.co' })).toBe(false)
  })
})
