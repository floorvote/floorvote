interface DatedAction { date: string; action: string }

// Strip leading "MM/DD/YYYY " date prefix that some states embed in action descriptions
export const stripDatePrefix = (s: string) => /^\d{2}\/\d{2}\/\d{4} /.test(s) ? s.slice(11) : s

// Monitoring-only (stub) bills get fresh `lastAction` from the masterlist sync but their
// `history` is only refreshed by getBill, which never runs for stubs — so the timeline can
// lag the headline action. When the last action isn't represented in history, return a
// synthetic entry to prepend so the unfolded timeline never omits the action shown elsewhere.
export function syntheticLatestAction(
  entries: DatedAction[],
  lastAction: string | null,
  lastActionDate: string | null,
): { date: string; action: string } | null {
  if (!lastAction || !lastActionDate) return null
  const action = stripDatePrefix(lastAction)
  const represented = entries.some(e => e.date === lastActionDate && stripDatePrefix(e.action) === action)
  if (represented) return null
  const newestEntryDate = entries.reduce((max, e) => (e.date > max ? e.date : max), '')
  if (lastActionDate < newestEntryDate) return null
  return { date: lastActionDate, action }
}

/**
 * True when the bill's stored detail (actions, referrals, pending committee) is older than its
 * last action: the last action is newer than, and missing from, a non-empty history. A stub bill's
 * last action is refreshed from the master list, but its detail only when a tenant tracks it, so
 * anything read from that detail can contradict the last action. An empty history means the
 * detail was never fetched, so there is nothing to gap against.
 */
export function isBillDetailStale(
  entries: DatedAction[],
  lastAction: string | null,
  lastActionDate: string | null,
): boolean {
  return entries.length > 0 && syntheticLatestAction(entries, lastAction, lastActionDate) !== null
}
