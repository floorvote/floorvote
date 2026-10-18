/**
 * Companion suggestions from matching titles (#521): the matching rule, pure.
 * In a state whose provider names no identical companions, a House bill and a
 * Senate bill with the same title are usually the same bill filed twice, so an
 * admin's bill page suggests grouping them (see **Title-matched suggestion**
 * in CONTEXT.md).
 *
 * A pair is suggested when both bills are in the same session, one in each of
 * two chambers, of the same eligible bill type (never a resolution: the
 * provider's vocabulary lists the eligible types), with titles equal after
 * normalizing case, punctuation, and whitespace, at least
 * `MIN_TITLE_LENGTH` characters long, and no third bill of that type in that
 * session holds the title. Research in #384 measured it against provider
 * labels: 85% of the pairs it suggests are labeled identical, and it finds 85%
 * of the labeled pairs.
 *
 * Central computes each bill's key (`titleKey`) from its provider's vocabulary
 * and serves it. Instances store it, indexed by state and session, and pair
 * the few bills that hold one key (`titleCompanionPairs`). Nothing here ever
 * compares every title with every other: a whole-state title self-join once
 * exceeded D1's CPU limit and reset a production database.
 */

/** The shortest normalized title that can be matched. Shorter titles are subject headings, too often shared by different bills. */
export const MIN_TITLE_LENGTH = 30

/**
 * A title with case, punctuation, and whitespace normalized: lowercase, every
 * run of anything but letters and digits made one space, trimmed. Accented
 * letters stay letters.
 */
export function normalizeTitle(title: string): string {
  return title.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
}

export interface TitleKeyInput {
  title: string
  /** The value the provider writes to `bills.bill_type`. */
  billType: string | null
  /** The bill's chamber as central stores it (`bills.body`). Empty for a stub central hasn't fetched. */
  chamber: string | null
}

/**
 * The key a bill is matched by: its bill type and normalized title. Null when
 * no suggestion can come from the bill: its type isn't one of `billTypes`
 * (compared without regard to case), its type or chamber is unknown (a stub,
 * whose type central only defaulted), or its normalized title is shorter than
 * `MIN_TITLE_LENGTH`. Carrying the type in the key keeps bills of different
 * types apart in one indexed lookup.
 */
export function titleKey(bill: TitleKeyInput, billTypes: readonly string[]): string | null {
  const type = bill.billType?.trim().toUpperCase()
  if (!type || !bill.chamber) return null
  if (!billTypes.some(t => t.toUpperCase() === type)) return null
  const title = normalizeTitle(bill.title)
  if (title.length < MIN_TITLE_LENGTH) return null
  return `${type}|${title}`
}

/** A bill as an instance stores it for matching: its key from central, its session, and its chamber. */
export interface KeyedBill {
  id: string
  sessionId: string | null
  chamber: string | null
  titleKey: string | null
}

/**
 * The suggested pairs among `bills`: each key held in one session by exactly
 * two bills, in different chambers. A key held by three or more bills there
 * suggests nothing. Bills with no key, session, or chamber are never paired.
 */
export function titleCompanionPairs<T extends KeyedBill>(bills: readonly T[]): Array<[T, T]> {
  const byKey = new Map<string, T[]>()
  for (const b of bills) {
    if (!b.titleKey || !b.sessionId || !b.chamber) continue
    const k = JSON.stringify([b.sessionId, b.titleKey])
    const list = byKey.get(k)
    if (list) list.push(b)
    else byKey.set(k, [b])
  }
  const pairs: Array<[T, T]> = []
  for (const list of byKey.values()) {
    if (list.length === 2 && list[0].chamber !== list[1].chamber) pairs.push([list[0], list[1]])
  }
  return pairs
}

export interface TitleMatchBill extends TitleKeyInput {
  id: string
  sessionId: string | null
}

/** The whole rule over raw bills: each keyed as `titleKey` does, then paired. */
export function matchTitleCompanions<T extends TitleMatchBill>(bills: readonly T[], billTypes: readonly string[]): Array<[T, T]> {
  const keyed = bills.map(b => ({ bill: b, id: b.id, sessionId: b.sessionId, chamber: b.chamber, titleKey: titleKey(b, billTypes) }))
  return titleCompanionPairs(keyed).map(([a, b]) => [a.bill, b.bill])
}
