/**
 * The calendar UID of a bill's calendar entry: the bill's handle and the
 * entry's identity, which central never changes for an entry
 * (central/src/lib/billCalendar.ts). Every subscriber's calendar knows the
 * entry by it, so this must never change either.
 */
export function hearingUid(billId: string, identityKey: string, tenantId: string): string {
  const slug = identityKey.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  const billPart = billId.replace(/[^a-z0-9]+/gi, '-')
  return `hearing-${billPart}-${slug}@${tenantId}`
}
