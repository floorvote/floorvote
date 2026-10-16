import { useEffect, useState } from 'react'
import { apiFetch } from '../lib/api'
import { color, fontSize } from '../styles/tokens'

interface CommentsMuteToggleProps {
  billId: string
  initialMuted: boolean
}

/**
 * Mute or unmute a bill's comments for the signed-in member (#355). A muted
 * bill sends them no reply notifications, in the app or by email. Mentions
 * still reach them. Works whether or not they have commented.
 *
 * The toggle flips at once and flips back if the request fails. It follows
 * the page's bill data, so moving to another bill shows that bill's state.
 */
export function useCommentsMute({ billId, initialMuted }: CommentsMuteToggleProps) {
  const [muted, setMuted] = useState(initialMuted)
  const [pending, setPending] = useState(false)
  useEffect(() => { setMuted(initialMuted) }, [billId, initialMuted])

  async function toggle() {
    const next = !muted
    setMuted(next)
    setPending(true)
    try {
      await apiFetch(`/bills/${billId}/mute`, { method: next ? 'PUT' : 'DELETE' })
    } catch {
      setMuted(!next)
    } finally {
      setPending(false)
    }
  }

  return { muted, pending, toggle }
}

/** The Mute/Unmute button that sits in the comments section's header. */
export function CommentsMuteButton({ muted, pending, onToggle }: { muted: boolean; pending: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={pending}
      style={{
        fontSize: fontSize.sm, color: color.textMuted, background: 'none', border: 'none',
        padding: 0, cursor: pending ? 'default' : 'pointer', textTransform: 'none', letterSpacing: 0,
      }}
    >
      {muted ? 'Unmute comments' : 'Mute comments'}
    </button>
  )
}

/** The line under the header while the bill is muted. */
export function CommentsMutedNote() {
  return (
    <p style={{ margin: '-6px 0 14px', fontSize: fontSize.sm, color: color.textMuted }}>
      You won't be notified of new comments on this bill. Mentions still reach you.
    </p>
  )
}
