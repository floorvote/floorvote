// Single source of truth for "does this look like a deliverable email
// address?" — used by the invite paste parser (web), the member-address check
// used by bulk invite and change-email (api), and the magic-link request (api).
//
// Deliberately stricter than RFC 5322: the domain must be dot-separated
// labels ending in an alphabetic TLD. The point is to reject spreadsheet
// debris — `jane@county.gov;`, `jane@county.gov.`, `jane@county.gov)` all
// passed the old `^[^\s@]+@[^\s@]+\.[^\s@]+$` check, were stored, and then
// failed at the mail provider on every send. Unicode letters are allowed in
// domain labels so internationalized domains still pass.
const EMAIL_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?\.)+\p{L}{2,}$/u

export function isValidEmail(s: string): boolean {
  return EMAIL_RE.test(s)
}

// Punctuation a copied list leaves stuck to an address: separators (`;` `,`),
// sentence punctuation (`.` `:` `!` `?`), and wrappers (`<>` `()` `[]` quotes).
const EDGE_PUNCT_RE = /^[;,.:!?<>()[\]"']+|[;,.:!?<>()[\]"']+$/g

/**
 * Strip stray punctuation from both ends of a token. Only for client-side
 * paste cleanup, where the admin sees the cleaned address in the preview —
 * the server rejects malformed input rather than silently rewriting it.
 */
export function trimEmailPunctuation(s: string): string {
  return s.trim().replace(EDGE_PUNCT_RE, '')
}
