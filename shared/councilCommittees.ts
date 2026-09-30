/**
 * DC Council committee names as a comparable key. The Council writes a
 * committee as "Committee on Youth Affairs" on its site and as "Youth Affairs"
 * on its hearing calendar; both become "youth affairs".
 */
export function committeeKey(name: string): string {
  return name.toLowerCase().replace(/^(the\s+)?committee\s+(on|of)\s+(the\s+)?/, '').replace(/[^a-z ]+/g, ' ').replace(/\s+/g, ' ').trim()
}

/** Calendar titles that are not committees, such as the full Council's legislative meetings. */
export const NON_COMMITTEE_TITLES = ['Legislative Meeting']

/**
 * Saved committee names that match no current committee: after a
 * reorganization, a rule naming a renamed or dissolved committee silently stops
 * matching. "Committee of the Whole" is kept as a committee.
 */
export function staleCommittees(saved: string[], current: string[]): string[] {
  const keys = new Set(current.map(committeeKey))
  const skip = new Set(NON_COMMITTEE_TITLES.map(committeeKey))
  return [...new Set(saved)].filter(n => {
    const k = committeeKey(n)
    return !skip.has(k) && !keys.has(k) && !(k === 'whole' && [...keys].some(x => x.includes('whole')))
  })
}
