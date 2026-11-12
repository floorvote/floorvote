/**
 * Answers `GET /bills/facets` the way the API does for `omit` and `only`, from a test's full facets fixture.
 *
 * The Subject and Committee counts are the costly part of a facets reply and are used only inside those two filter
 * controls, so the Bills page leaves them out of its page-load request (`omit=subject,committee`) and asks for them on
 * their own (`only=subject,committee`) when someone is about to use a control. The tenant keys (`subjectStates`,
 * `billStates`, `hasDrafts`, `hasCommittees`) come with every reply. A fixture without `hasCommittees` gets it from
 * whether its committee counts name any committee.
 */
const PART_KEYS: Record<string, readonly string[]> = {
  subject: ['subject'],
  committee: ['committee', 'committeeInfo'],
}
const TENANT_KEYS = ['subjectStates', 'billStates', 'hasDrafts', 'hasCommittees'] as const

export function facetsReply(path: string, full: Record<string, unknown>): Record<string, unknown> {
  const withTenant: Record<string, unknown> = {
    ...full,
    hasCommittees: full.hasCommittees ?? Object.keys((full.committee as Record<string, number> | undefined) ?? {}).length > 0,
  }
  const qs = new URLSearchParams(path.split('?')[1] ?? '')
  const parts = (name: string) => (qs.get(name) ?? '').split(',').filter(Boolean).flatMap(p => PART_KEYS[p] ?? [])
  const only = parts('only')
  if (only.length > 0) {
    return Object.fromEntries(Object.entries(withTenant).filter(([k]) => only.includes(k) || (TENANT_KEYS as readonly string[]).includes(k)))
  }
  const omit = parts('omit')
  return Object.fromEntries(Object.entries(withTenant).filter(([k]) => !omit.includes(k)))
}

/** The filter part of a facets request, with `omit` and `only` taken off, so two requests can be compared by filter. */
export function facetsFilterOf(path: string): string {
  const qs = new URLSearchParams(path.split('?')[1] ?? '')
  qs.delete('omit')
  qs.delete('only')
  return qs.toString()
}

/** Whether a recorded call is the on-demand Subject/Committee request (`only=` names a part). */
export function isLazyFacetsCall(path: string): boolean {
  return path.startsWith('/bills/facets') && new URLSearchParams(path.split('?')[1] ?? '').has('only')
}

/** Whether a recorded call is the page-load facets request. */
export function isPageFacetsCall(path: string): boolean {
  return path.startsWith('/bills/facets') && !new URLSearchParams(path.split('?')[1] ?? '').has('only')
}
