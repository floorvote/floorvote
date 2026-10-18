import { forwardRef, type KeyboardEvent, type Ref } from 'react'
import { color, radius, fontSize, fontWeight } from '../styles/tokens'
import { pillText, type EmailChangeState } from '../lib/emailChangeState'

const VISUALLY_HIDDEN: React.CSSProperties = {
  position: 'absolute', width: 1, height: 1, margin: -1, padding: 0, overflow: 'hidden',
  clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap', border: 0,
}

const LINK_BUTTON: React.CSSProperties = {
  background: 'none', border: 'none', padding: 0, fontSize: fontSize.sm, color: color.linkBlue, cursor: 'pointer',
}

interface EmailChangePillProps {
  state: EmailChangeState
  onResend: () => void
  onCancel: () => void
  /** Resend can't go yet, such as while it waits for a fresh Turnstile token. */
  resendDisabled?: boolean
  /** What a screen reader hears for a confirmed change. */
  confirmedAnnounce?: string
  resendRef?: Ref<HTMLButtonElement>
}

/**
 * The pill that stands in for the edit form once a change is under way:
 * "→ new address · Link sent" with Resend and Cancel, or "✓ Changed today".
 * The pill's words are short; the live region carries the fuller message.
 * Escape on its buttons cancels it, the same as Escape in the input.
 */
export const EmailChangePill = forwardRef<HTMLDivElement, EmailChangePillProps>(function EmailChangePill(
  { state, onResend, onCancel, resendDisabled, confirmedAnnounce, resendRef }, ref,
) {
  const text = pillText(state)
  if (!text) return null

  function handleKeyDown(e: KeyboardEvent) {
    if (state.kind === 'pending' && e.key === 'Escape') {
      e.preventDefault()
      onCancel()
    }
  }

  const pending = state.kind === 'pending'
  const announce = state.kind === 'pending' ? state.announce : confirmedAnnounce

  return (
    <div ref={ref} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, marginTop: 6 }}>
      <span
        style={{
          fontSize: fontSize.sm, fontWeight: fontWeight.semibold, padding: '2px 8px', borderRadius: radius.sm,
          background: pending ? color.bgInfo : color.bgSuccessChip,
          color: pending ? color.textPrimary : color.textSuccessDark,
          overflowWrap: 'anywhere',
        }}
      >
        {text}
      </span>
      {state.kind === 'pending' && (
        <>
          <button
            type="button"
            ref={resendRef}
            onClick={onResend}
            onKeyDown={handleKeyDown}
            disabled={state.busy || resendDisabled}
            style={{ ...LINK_BUTTON, color: state.busy || resendDisabled ? color.textMuted : color.linkBlue, cursor: state.busy || resendDisabled ? 'not-allowed' : 'pointer' }}
          >
            {state.busy ? 'Sending…' : 'Resend'}
          </button>
          <button type="button" onClick={onCancel} onKeyDown={handleKeyDown} style={{ ...LINK_BUTTON, color: color.textSecondary }}>
            Cancel
          </button>
        </>
      )}
      {state.kind === 'pending' && state.error && (
        <div role="alert" style={{ flexBasis: '100%', fontSize: fontSize.sm, color: color.textErrorRed }}>{state.error}</div>
      )}
      {announce && <span role="status" style={VISUALLY_HIDDEN}>{announce}</span>}
    </div>
  )
})
