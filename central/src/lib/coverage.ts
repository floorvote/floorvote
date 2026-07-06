/**
 * Merge a tenant's existing state_coverage with incoming states (set union).
 *
 * A wildcard ('*') on either side collapses to ['*']. Existing order is
 * preserved and new states are appended. Used by the /register route (merge
 * instead of overwrite) and by seed-session (add the seeded session's state)
 * so that seeding a state's bills for a tenant durably makes the cron poll
 * that state — previously seed-session linked bills without ever updating
 * coverage, leaving the bills static and unpolled.
 */
export function mergeCoverage(
  existing: string[] | null | undefined,
  incoming: string[],
): string[] {
  const ex = existing ?? []
  if (ex.includes('*') || incoming.includes('*')) return ['*']
  const out = [...ex]
  for (const s of incoming) {
    if (!out.includes(s)) out.push(s)
  }
  return out
}
