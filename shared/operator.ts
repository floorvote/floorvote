/**
 * Parse a comma-separated env var (e.g. OPERATOR_CONTACT_EMAILS) into a trimmed,
 * non-empty list. Mirrors how ALERT_EMAILS is parsed in jobAlert.ts.
 */
export function parseEmailList(raw: string | undefined): string[] {
  return (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean)
}
