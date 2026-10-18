import { useEffect, useId, useRef, type FormEvent, type KeyboardEvent } from 'react'
import { apiFetch, ApiError } from '../lib/api'
import { color, radius, fontSize, fontWeight } from '../styles/tokens'
import { MissingRequiredReason, useRequiredSubmit } from './RequiredField'
import { isValidEmail, trimEmailPunctuation } from '../../../shared/email'
import { LINK_OUT_NOTE, type EmailChangeAction, type EmailChangeState } from '../lib/emailChangeState'

// Messages the server also sends, so a refusal reads the same whichever side
// catches it.
const INVALID = 'Invalid email address'
const UNCHANGED_INVITE = "That's already their address. Check it for a typo, or use Resend invite to send to it again."
const UNCHANGED_ACTIVE = "That's already their address. Check it for a typo."

interface MemberEmailEditorProps {
  member: { id: string; email: string }
  /**
   * A pending invite's address is fixed on the spot and a new invite goes out.
   * An active member's change is only asked for: it takes effect when they
   * confirm it from the new address.
   */
  pendingInvite: boolean
  state: Extract<EmailChangeState, { kind: 'editing' }>
  dispatch: (action: EmailChangeAction) => void
  onCancel: () => void
  /**
   * Called once the request is accepted. For a pending invite the address is
   * saved and the new invite is on its way. For an active member (`pending`)
   * a confirmation is on its way to the new address and nothing has changed yet.
   */
  onChanged: (email: string, pending: boolean) => void
}

/**
 * The inline editor in a member's row: fix a pending invite's address and send
 * a new invite in one step, or ask to change an active member's address, which
 * waits for the new address to confirm it. The address is cleaned the way the
 * invite paste parser cleans one (stray edge punctuation, then lowercase) and
 * checked with the same shared rule, so an obviously bad or unchanged address
 * never reaches the server.
 */
export function MemberEmailEditor({ member, pendingInvite, state, dispatch, onCancel, onChanged }: MemberEmailEditorProps) {
  const unchanged = pendingInvite ? UNCHANGED_INVITE : UNCHANGED_ACTIVE
  const inputRef = useRef<HTMLInputElement>(null)
  const errorId = useId()
  const gate = useRequiredSubmit({ missingRequired: !state.value.trim(), blocked: state.sending })

  useEffect(() => { inputRef.current?.focus() }, [])

  function refuse(message: string) {
    dispatch({ type: 'refused', message })
    // The field was disabled while sending, which drops focus.
    requestAnimationFrame(() => inputRef.current?.focus())
  }

  async function handleSubmit(e?: FormEvent) {
    e?.preventDefault()
    if (gate.refuse()) return
    const email = trimEmailPunctuation(state.value).toLowerCase()
    if (!isValidEmail(email)) { refuse(INVALID); return }
    if (email === member.email.trim().toLowerCase()) { refuse(unchanged); return }

    dispatch({ type: 'send' })
    try {
      const res = await apiFetch<{ ok: true; email: string; pending?: boolean }>(`/admin/members/${member.id}/change-email`, {
        method: 'POST',
        body: JSON.stringify({ email }),
      })
      onChanged(res.email ?? email, res.pending === true)
    } catch (err) {
      refuse(err instanceof ApiError ? err.message : "Couldn't change the address. Try again.")
    }
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape' && !state.sending) {
      e.preventDefault()
      onCancel()
    }
  }

  return (
    <form onSubmit={handleSubmit} noValidate style={{ marginTop: 6 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
        <input
          ref={inputRef}
          type="email"
          autoComplete="off"
          spellCheck={false}
          aria-label="Email address"
          value={state.value}
          onChange={(e) => dispatch({ type: 'edit', value: e.target.value })}
          onKeyDown={handleKeyDown}
          aria-required="true"
          aria-invalid={state.error ? 'true' : undefined}
          aria-describedby={state.error ? errorId : gate.fieldProps['aria-describedby']}
          disabled={state.sending}
          style={{
            flex: '1 1 160px', minWidth: 0, fontSize: fontSize.sm, padding: '5px 8px', boxSizing: 'border-box',
            border: `1px solid ${state.error ? color.textErrorRed : color.borderDefault}`, borderRadius: radius.md,
            color: color.textPrimary, opacity: state.sending ? 0.6 : 1,
          }}
        />
        <button
          type="submit"
          {...gate.buttonProps()}
          style={{
            padding: '5px 12px', background: color.billBadgeNavy, color: color.textOnFill,
            border: 'none', borderRadius: radius.md, fontSize: fontSize.sm, fontWeight: fontWeight.semibold,
            cursor: gate.disabled ? 'not-allowed' : 'pointer', opacity: gate.disabled ? 0.5 : 1,
          }}
        >
          {state.sending ? 'Sending…' : 'Send link'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          onKeyDown={handleKeyDown}
          disabled={state.sending}
          style={{
            background: 'none', border: `1px solid ${color.borderDefault}`, borderRadius: radius.md,
            padding: '5px 10px', fontSize: fontSize.sm, color: color.textSecondary,
            cursor: state.sending ? 'not-allowed' : 'pointer',
          }}
        >
          Cancel
        </button>
      </div>
      {state.error && (
        <p id={errorId} role="alert" style={{ fontSize: fontSize.sm, color: color.textErrorRed, margin: '6px 0 0' }}>
          {state.error}
        </p>
      )}
      {state.linkOut && (
        <p style={{ fontSize: fontSize.sm, color: color.textSecondary, margin: '6px 0 0' }}>{LINK_OUT_NOTE}</p>
      )}
      {/* Below the button row, never in it: revealing it must not move the button. */}
      <MissingRequiredReason {...gate.reasonProps} />
    </form>
  )
}
