/**
 * A person's "Newly found bills" choice as stored in users.email_digest_new_bills (1, 0, or null), read as /auth/me
 * sends it and newlyFoundOn takes it: true or false once they chose, null while unset. Unset follows the team's
 * default for a member and is on for an admin or owner (#1036).
 */
export function newBillsChoice(stored: number | null): boolean | null {
  return stored === null ? null : stored === 1
}
