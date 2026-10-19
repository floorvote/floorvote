import { isValidEmail } from './email'

/**
 * Parse a comma-separated env var (e.g. OPERATOR_CONTACT_EMAILS) into a trimmed,
 * non-empty list. Does not check the entries: a caller that sends to the list
 * uses `validEmailList`. This one is for a caller that only shows or reads it.
 */
export function parseEmailList(raw: string | undefined): string[] {
  return (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean)
}

/**
 * The addresses to send to, from a comma-separated env var (`ALERT_EMAILS`,
 * `OPERATOR_CONTACT_EMAILS`): trimmed, blanks dropped, each address once
 * (ignoring case, the first spelling kept), and only the ones the sender will
 * accept. The sender rejects a whole message over one bad recipient, so one
 * typo in the setting would block the alert to every good address too. Each
 * dropped entry is logged, once, in a single line naming the variable, so
 * the operator can fix it. An unset or blank variable logs nothing here: the
 * caller already says "unset" when the result is empty.
 *
 * Only a bare address is valid. The display-name form (`Ops <ops@example.com>`)
 * is dropped, like every entry the sender's own check refuses: it is not a
 * deliverable recipient there, and splitting on commas would cut a quoted name
 * that holds one in half.
 */
export function validEmailList(raw: string | undefined, source: string): string[] {
  const valid: string[] = []
  const seen = new Set<string>()
  const dropped: string[] = []
  for (const entry of parseEmailList(raw)) {
    if (!isValidEmail(entry)) {
      if (!dropped.includes(entry)) dropped.push(entry)
      continue
    }
    const key = entry.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    valid.push(entry)
  }
  if (dropped.length > 0) {
    console.error(`[${source}] ignoring ${dropped.length === 1 ? 'an entry' : `${dropped.length} entries`} that ${dropped.length === 1 ? 'is' : 'are'} not a valid email address: ${dropped.map((e) => JSON.stringify(e)).join(', ')}`)
  }
  return valid
}
