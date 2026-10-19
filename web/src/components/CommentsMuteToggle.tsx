import { useEffect, useId, useState } from 'react'
import { apiFetch } from '../lib/api'
import { color, fontSize } from '../styles/tokens'
import { HoverTooltip } from './HoverTooltip'

interface CommentsMuteToggleProps {
  billId: string
  initialMuted: boolean
}

/**
 * Mute or unmute a bill's comments for the signed-in member (#355). A muted
 * bill sends them no reply notifications, in the app or by email. Mentions
 * still reach them. Works whether or not they have commented. The bill page
 * offers it only while the member's "Replies on bills you've commented on"
 * setting is on, since with it off they get no replies on any bill.
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

const MUTE_TOOLTIP = "You're notified of new comments here because you've commented on this bill. Mute to stop for this bill only. Mentions still reach you."
const UNMUTE_TOOLTIP = "You've muted this bill, so you won't be notified of new comments here. Mentions still reach you."

/**
 * The Mute/Unmute button that sits in the comments section's header. Its hover
 * says what the state means, in place of a note under the heading.
 */
export function CommentsMuteButton({ muted, pending, onToggle }: { muted: boolean; pending: boolean; onToggle: () => void }) {
  const describeId = useId()
  return (
    <HoverTooltip text={muted ? UNMUTE_TOOLTIP : MUTE_TOOLTIP} maxWidth={280} placement="bottom" describe={{ id: describeId, interactive: true }}>
      <button
        type="button"
        onClick={onToggle}
        disabled={pending}
        aria-describedby={describeId}
        style={{
          fontSize: fontSize.sm, color: color.textMuted, background: 'none', border: 'none',
          padding: 0, cursor: pending ? 'default' : 'pointer', textTransform: 'none', letterSpacing: 0,
        }}
      >
        {muted ? 'Unmute comments' : 'Mute comments'}
      </button>
    </HoverTooltip>
  )
}
