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
const UNCHANGED = "That's already their address. Check it for a typo, or use Resend invite to send to it again."

interface ChangeEmailDialogProps {
  member: { id: string; email: string }
  onClose: () => void
  /** Called with the stored address once the change is saved and the new invite is on its way. */
  onChanged: (email: string) => void
}

/**
 * Fix a pending invite's address and send a new invite in one step. The
 * address is cleaned the way the invite paste parser cleans one (stray edge
 * punctuation, then lowercase) and checked with the same shared rule, so an
 * obviously bad or unchanged address never reaches the server.
 */
export function ChangeEmailDialog({ member, onClose, onChanged }: ChangeEmailDialogProps) {
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
    if (email === member.email.trim().toLowerCase()) { setError(UNCHANGED); return }

    setSending(true)
    setError(null)
    try {
      const res = await apiFetch<{ ok: true; email: string }>(`/admin/members/${member.id}/change-email`, {
        method: 'POST',
        body: JSON.stringify({ email }),
      })
      onChanged(res.email ?? email)
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
          The old invite link will stop working, and a new invite goes to this address.
        </p>

        <div style={{ marginTop: 12, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12 }}>
          <button
            type="submit"
            {...gate.buttonProps()}
            style={{
              padding: '8px 20px', background: color.billBadgeNavy, color: color.white,
              border: 'none', borderRadius: radius.md, fontSize: fontSize.sm, fontWeight: fontWeight.semibold,
              cursor: gate.disabled ? 'not-allowed' : 'pointer',
              opacity: gate.disabled ? 0.5 : 1,
            }}
          >
            {sending ? 'Sending…' : 'Send new invite'}
          </button>
        </div>
        {/* Below the button row, never in it: revealing it must not move the button. */}
        <MissingRequiredReason {...gate.reasonProps} />
      </form>
    </Dialog>
  )
}
