/**
 * An untriaged new match: a keyword match that has not been given a priority or
 * dismissed. It reads as an amber state of the priority control, so the mark
 * and the place to resolve it are the same thing. Once it is resolved (a
 * priority set, or Dismiss chosen) this goes false and the control is the plain
 * priority dropdown.
 */
export function isUntriagedNewMatch(bill: {
  matchType?: string | null
  newMatchAt?: string | null
  priority?: string | null
  triagedAt?: string | null
}): boolean {
  return bill.matchType === 'keyword' && !!bill.newMatchAt && !bill.priority && !bill.triagedAt
}
