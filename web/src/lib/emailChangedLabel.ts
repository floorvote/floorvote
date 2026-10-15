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

/**
 * The steps of a confirmed email change (email_change_requested / _confirmed
 * / _cancelled / _reported). `email` is the new address, `reason` the old one,
 * and `actorId` the member who asked for the change. A report has no actor:
 * whoever pressed "This wasn't me" was not signed in.
 */
export type EmailChangeStepFields = EmailChangedFields & { event: string; actorId?: string | null }

const cancelled = (e: EmailChangeStepFields) => `Email change to ${e.email} cancelled`

/** For the member's own Account history, where their own steps read "you". */
export function ownEmailChangeLabel(e: EmailChangeStepFields, selfId: string): string | null {
  const self = e.actorId === selfId
  const who = e.actorName || 'An admin'
  switch (e.event) {
    case 'email_change_requested':
      return self ? `You asked to change your email to ${e.email}` : `${who} asked to change your email to ${e.email}`
    case 'email_change_confirmed':
      return self
        ? `You changed your email from ${e.reason} to ${e.email}`
        : `Your email was changed from ${e.reason} to ${e.email} at the request of ${who}`
    case 'email_change_cancelled':
      return cancelled(e)
    case 'email_change_reported':
      return `"This wasn't me" was pressed for the change of your email from ${e.reason} to ${e.email}, and every session was signed out`
    default:
      return null
  }
}

/** For an admin's Member history of `memberId`. */
export function memberEmailChangeLabel(e: EmailChangeStepFields, memberId: string): string | null {
  const by = e.actorId === memberId ? 'the member' : e.actorName || 'an admin'
  switch (e.event) {
    case 'email_change_requested':
      return `Email change to ${e.email} requested by ${by}`
    case 'email_change_confirmed':
      return `Email changed from ${e.reason} to ${e.email}, requested by ${by}`
    case 'email_change_cancelled':
      return cancelled(e)
    case 'email_change_reported':
      return `"This wasn't me" was pressed for the change from ${e.reason} to ${e.email}, and all of the member's sessions were signed out`
    default:
      return null
  }
}
