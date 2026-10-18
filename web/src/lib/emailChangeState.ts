// The states of an email-change row, shared by the member's own Profile row and
// the admin's Members row so the two cannot drift apart:
//
//   idle       the row shows the address and its "Change email…" button
//   editing    an input, a send button, and Cancel; a refusal shows under the input
//   pending    "→ new address · Link sent" with Resend and Cancel. The current
//              address stays until the new one confirms.
//   confirmed  "✓ Changed today"
//
// Pure and free of React so it can be unit-tested on its own.

export type EmailChangeState =
  | { kind: 'idle' }
  | { kind: 'editing'; value: string; error: string | null; sending: boolean }
  | { kind: 'pending'; to: string; busy: boolean; error: string | null; announce: string }
  | { kind: 'confirmed'; email: string }

export type EmailChangeAction =
  | { type: 'open'; value?: string }
  | { type: 'edit'; value: string }
  | { type: 'send' }
  | { type: 'refused'; message: string }
  | { type: 'sent'; to: string; announce: string }
  | { type: 'resend' }
  | { type: 'resent'; announce: string }
  | { type: 'resendFailed'; message: string }
  | { type: 'cancel' }
  | { type: 'confirmed'; email: string }

export const IDLE: EmailChangeState = { kind: 'idle' }

export function emailChangeReducer(state: EmailChangeState, action: EmailChangeAction): EmailChangeState {
  switch (action.type) {
    case 'open':
      if (state.kind === 'editing' && state.sending) return state
      return { kind: 'editing', value: action.value ?? '', error: null, sending: false }
    case 'edit':
      if (state.kind !== 'editing') return state
      return { ...state, value: action.value, error: null }
    case 'send':
      if (state.kind !== 'editing') return state
      return { ...state, sending: true, error: null }
    case 'refused':
      if (state.kind !== 'editing') return state
      return { ...state, sending: false, error: action.message }
    case 'sent':
      return { kind: 'pending', to: action.to, busy: false, error: null, announce: action.announce }
    case 'resend':
      if (state.kind !== 'pending') return state
      return { ...state, busy: true, error: null }
    case 'resent':
      if (state.kind !== 'pending') return state
      return { ...state, busy: false, error: null, announce: action.announce }
    case 'resendFailed':
      if (state.kind !== 'pending') return state
      return { ...state, busy: false, error: action.message }
    case 'cancel':
      return IDLE
    case 'confirmed':
      return { kind: 'confirmed', email: action.email }
  }
}

/** The short pill copy, or null when the state has no pill. */
export function pillText(state: EmailChangeState): string | null {
  if (state.kind === 'pending') return `→ ${state.to} · Link sent`
  if (state.kind === 'confirmed') return '✓ Changed today'
  return null
}

/** True while an edit or a pending change takes the row's place. */
export function isEmailChangeOpen(state: EmailChangeState): boolean {
  return state.kind === 'editing' || state.kind === 'pending'
}
