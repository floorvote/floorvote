import { useId, useRef, useState, type FormEvent } from 'react'
import { apiFetch, ApiError } from '../lib/api'
import { color, radius, fontSize, fontWeight } from '../styles/tokens'
import { FORM_LABEL, HELPER_TEXT } from '../lib/textStyles'
import { Dialog } from './ui/Dialog'
import { MissingRequiredReason, useRequiredSubmit } from './RequiredField'
import { isValidEmail, trimEmailPunctuation } from '../../../shared/email'

// Messages the server also sends, so a refusal reads the same whichever side
// catches it.
const INVALID = 'Invalid email address'
const UNCHANGED_INVITE = "That's already their address. Check it for a typo, or use Resend invite to send to it again."
const UNCHANGED_ACTIVE = "That's already their address. Check it for a typo."

interface ChangeEmailDialogProps {
  member: { id: string; email: string }
  /**
   * A pending invite's address is fixed on the spot and a new invite goes out.
   * An active member's change is only asked for: it takes effect when they
   * confirm it from the new address.
   */
  pendingInvite: boolean
  onClose: () => void
  /**
   * Called once the request is accepted. For a pending invite the address is
   * saved and the new invite is on its way. For an active member (`pending`)
   * a confirmation is on its way to the new address and nothing has changed yet.
   */
  onChanged: (email: string, pending: boolean) => void
}

/**
 * Fix a pending invite's address and send a new invite in one step, or ask to
 * change an active member's address, which waits for the new address to confirm
 * it. The address is cleaned the way the invite paste parser cleans one (stray edge
 * punctuation, then lowercase) and checked with the same shared rule, so an
 * obviously bad or unchanged address never reaches the server.
 */
export function ChangeEmailDialog({ member, pendingInvite, onClose, onChanged }: ChangeEmailDialogProps) {
  const unchanged = pendingInvite ? UNCHANGED_INVITE : UNCHANGED_ACTIVE
  const [value, setValue] = useState(member.email)
  const [error, setError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const inputId = useId()
  const errorId = useId()

  const gate = useRequiredSubmit({ missingRequired: !value.trim(), blocked: sending })

  async function handleSubmit(e?: FormEvent) {
    e?.preventDefault()
    if (gate.refuse()) return
    const email = trimEmailPunctuation(value).toLowerCase()
    if (!isValidEmail(email)) { setError(INVALID); return }
    if (email === member.email.trim().toLowerCase()) { setError(unchanged); return }

    setSending(true)
    setError(null)
    try {
      const res = await apiFetch<{ ok: true; email: string; pending?: boolean }>(`/admin/members/${member.id}/change-email`, {
        method: 'POST',
        body: JSON.stringify({ email }),
      })
      onChanged(res.email ?? email, res.pending === true)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't change the address. Try again.")
      setSending(false)
      // The field was disabled while sending, which drops focus.
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }

  return (
    <Dialog onClose={sending ? () => {} : onClose} labelledBy="change-email-title" initialFocus={inputRef}>
      <button
        type="button"
        onClick={onClose}
        disabled={sending}
        style={{
          position: 'absolute', top: 12, right: 12, background: 'none', border: 'none',
          cursor: sending ? 'not-allowed' : 'pointer', color: color.textMuted, fontSize: fontSize.xl, lineHeight: 1,
        }}
        aria-label="Close"
      >
        ×
      </button>

      <div id="change-email-title" style={{ fontWeight: fontWeight.bold, fontSize: fontSize.base, color: color.textPrimary, marginBottom: 16 }}>
        Change email
      </div>

      <form onSubmit={handleSubmit} noValidate>
        <label htmlFor={inputId} style={FORM_LABEL}>Email address</label>
        <input
          id={inputId}
          ref={inputRef}
          type="email"
          autoComplete="off"
          spellCheck={false}
          value={value}
          onChange={(e) => { setValue(e.target.value); setError(null) }}
          aria-required="true"
          aria-invalid={error ? 'true' : undefined}
          aria-describedby={error ? errorId : gate.fieldProps['aria-describedby']}
          disabled={sending}
          style={{
            width: '100%', fontSize: fontSize.base, padding: '8px 10px', boxSizing: 'border-box',
            border: `1px solid ${error ? color.textErrorRed : color.borderDefault}`, borderRadius: radius.md,
            color: color.textPrimary, opacity: sending ? 0.6 : 1,
          }}
        />
        {error && (
          <p id={errorId} role="alert" style={{ fontSize: fontSize.sm, color: color.textErrorRed, margin: '8px 0 0' }}>
            {error}
          </p>
        )}
        <p style={{ ...HELPER_TEXT, margin: '8px 0 0' }}>
          {pendingInvite
            ? 'The old invite link will stop working, and a new invite goes to this address.'
            : 'We email this address a link to confirm the change, and tell the current address. Nothing changes until it is confirmed. When it is, the member is signed out everywhere and uses the new address to sign in.'}
        </p>

        <div style={{ marginTop: 12, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12 }}>
          <button
            type="submit"
            {...gate.buttonProps()}
            style={{
              padding: '8px 20px', background: color.billBadgeNavy, color: color.textOnFill,
              border: 'none', borderRadius: radius.md, fontSize: fontSize.sm, fontWeight: fontWeight.semibold,
              cursor: gate.disabled ? 'not-allowed' : 'pointer',
              opacity: gate.disabled ? 0.5 : 1,
            }}
          >
            {sending ? 'Sending…' : pendingInvite ? 'Send new invite' : 'Send confirmation'}
          </button>
        </div>
        {/* Below the button row, never in it: revealing it must not move the button. */}
        <MissingRequiredReason {...gate.reasonProps} />
      </form>
    </Dialog>
  )
}
