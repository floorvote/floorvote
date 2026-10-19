const VISUALLY_HIDDEN: React.CSSProperties = {
  position: 'absolute', width: 1, height: 1, margin: -1, padding: 0, overflow: 'hidden',
  clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap', border: 0,
}

/**
 * A polite live region for a new match's Dismiss. It stays mounted, empty, so
 * the text it gains on success is announced; the host owns the message.
 */
export function DismissAnnouncement({ message }: { message: string }) {
  return <span data-testid="dismiss-announcement" aria-live="polite" style={VISUALLY_HIDDEN}>{message}</span>
}
