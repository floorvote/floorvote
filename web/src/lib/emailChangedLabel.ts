// The "Email changed" entry in a member's login history, shared by Member
// history (admin) and the member's own Account history so the two read alike.

/** The fields an auth event carries for `email_changed`. */
export type EmailChangedFields = {
  /** The old address. */
  reason: string | null
  /** The address the event concerns; for email_changed, the new one. */
  email?: string
  /** The admin who made the change, or null once they're gone. */
  actorName?: string | null
}

export function emailChangedLabel(e: EmailChangedFields): string {
  return `Email changed from ${e.reason} to ${e.email}${e.actorName ? ` by ${e.actorName}` : ''}`
}
