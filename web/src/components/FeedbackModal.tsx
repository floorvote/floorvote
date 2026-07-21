import { useState } from 'react'
import { apiFetch } from '../lib/api'
import { color, radius, fontSize, fontWeight } from '../styles/tokens'
import { useConfig } from '../context/ConfigContext'
import { Dialog } from './ui/Dialog'

interface FeedbackModalProps {
  onClose: () => void
}

export function FeedbackModal({ onClose }: FeedbackModalProps) {
  const { config } = useConfig()
  const contactEmails = config?.operator?.contactEmails ?? []
  const [message, setMessage] = useState('')
  const [status, setStatus] = useState<'idle' | 'sending' | 'success' | 'error'>('idle')

  async function handleSubmit() {
    if (!message.trim() || status === 'sending') return
    setStatus('sending')
    try {
      await apiFetch('/feedback', {
        method: 'POST',
        body: JSON.stringify({ message: message.trim(), pageUrl: window.location.href }),
      })
      setStatus('success')
    } catch {
      setStatus('error')
    }
  }

  return (
    <Dialog onClose={status === 'sending' ? () => {} : onClose} labelledBy="feedback-title">
      <button
        onClick={onClose}
        disabled={status === 'sending'}
        style={{
          position: 'absolute', top: 12, right: 12, background: 'none', border: 'none',
          cursor: status === 'sending' ? 'not-allowed' : 'pointer', color: color.textMuted, fontSize: fontSize.xl, lineHeight: 1,
        }}
        aria-label="Close"
      >
        ×
      </button>

      <div id="feedback-title" style={{ fontWeight: fontWeight.bold, fontSize: fontSize.base, color: color.textPrimary, marginBottom: 16 }}>
        Send feedback
      </div>

      {status === 'success' ? (
        <p role="alert" style={{ fontSize: fontSize.base, color: color.textVoteSupport, margin: 0 }}>Feedback sent — thanks!</p>
      ) : (
        <>
          <label
            htmlFor="feedback-message"
            style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap' }}
          >
            Your message
          </label>
          <textarea
            id="feedback-message"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="What's on your mind?"
            disabled={status === 'sending'}
            style={{
              width: '100%', minHeight: 100, fontSize: fontSize.base, border: `1px solid ${color.borderDefault}`,
              borderRadius: radius.md, padding: 10, resize: 'vertical', boxSizing: 'border-box',
              fontFamily: 'inherit', color: color.textPrimary,
              opacity: status === 'sending' ? 0.6 : 1,
            }}
          />

          {status === 'error' && (
            <p role="alert" style={{ fontSize: fontSize.sm, color: color.textErrorRed, margin: '8px 0 0' }}>
              Something went wrong.
              {contactEmails.length > 0 && (
                <>
                  {' '}
                  <a href={`mailto:${contactEmails.join(',')}`} style={{ color: color.textErrorRed }}>
                    Email {contactEmails[0]}
                  </a>
                  {' '}directly.
                </>
              )}
            </p>
          )}

          <button
            onClick={handleSubmit}
            disabled={!message.trim() || status === 'sending'}
            style={{
              marginTop: 12, padding: '8px 20px', background: color.billBadgeNavy, color: color.white,
              border: 'none', borderRadius: radius.md, fontSize: fontSize.sm, fontWeight: fontWeight.semibold,
              cursor: !message.trim() || status === 'sending' ? 'not-allowed' : 'pointer',
              opacity: !message.trim() || status === 'sending' ? 0.5 : 1,
            }}
          >
            {status === 'sending' ? 'Sending…' : 'Send feedback'}
          </button>
        </>
      )}
    </Dialog>
  )
}
