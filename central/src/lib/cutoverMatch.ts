/**
 * How a cutover (lib/cutover.ts) matches a state's bills and legislators
 * across two providers. Pure functions, so the dry run and the cutover itself
 * match the same way.
 */

/** "HB0001" → "HB1", "B26-0400" → "B26-400": bill numbers compared without padding or spaces. */
export function comparableNumber(n: string): string {
  return n.toUpperCase().replace(/\s+/g, '').replace(/(^|\D)0+(?=\d)/g, '$1')
}

/**
 * The key a bill is matched on: its session's first year, whether the session
 * is special, and its number. Two providers name sessions differently, but
 * agree on these. A key two bills on one side share matches neither, since
 * there's no telling which is which (two special sessions in one year, say).
 */
export function billMatchKey(session: { yearStart: number; special: number }, number: string): string {
  return `${session.yearStart}|${session.special ? 1 : 0}|${comparableNumber(number)}`
}

/** One legislator, as either provider describes them. */
export interface PersonFacts {
  id: number
  name: string
  firstName?: string | null
  lastName?: string | null
  role?: string | null
  roleId?: number | null
  district?: string | null
  /** The member's Bioguide id, which Congress's members have in either provider. Blank is none. */
  bioguideId?: string | null
}

/** What two people's records agreed on, beyond their state: a Bioguide id alone, or the rest. */
export type MatchedOn = 'bioguide' | 'name' | 'chamber' | 'district'

export interface PersonMatch<A extends PersonFacts, B extends PersonFacts> {
  from: A
  to: B
  /**
   * How closely the names agreed: whole first and last names, last name and
   * first initial, or last name alone. Null for a match by Bioguide id, which
   * compares no names.
   */
  name: 'full' | 'initial' | 'last' | null
  on: MatchedOn[]
  /** Not confirmed by chamber and district both, such as a match on names alone. Never true of a match by Bioguide id. */
  weak: boolean
}

export interface PeopleMatch<A extends PersonFacts, B extends PersonFacts> {
  matched: PersonMatch<A, B>[]
  /** New people who weren't each other's one candidate with anyone, left unmatched with their candidates. */
  ambiguous: { person: B; candidates: A[] }[]
  /** Every old person left unmatched, an ambiguity's candidates included, so matched plus unmatched is everyone. */
  unmatchedFrom: A[]
  /** New people left unmatched, other than the ambiguous ones. */
  unmatchedTo: B[]
  /**
   * Bioguide ids two or more people on one side share. When the other side
   * has the id too, none of them match, by the id or by name, since there's no
   * telling which is which. When it doesn't, the id decides nothing, and
   * they're matched by name as anyone else is.
   */
  sharedBioguide: ({ side: 'old'; bioguideId: string; people: A[] } | { side: 'new'; bioguideId: string; people: B[] })[]
}

const TITLE = /^(?:the honorable|honorable|hon|delegate|del|senator|sen|representative|rep|assemblymember|assemblyman|assemblywoman|councilmember|council member|chairman|chairwoman|chairperson|chair|mr|mrs|ms|dr)\.?\s+/i
const SUFFIX = /,?\s+(?:jr|sr|ii|iii|iv)\.?$/i

function fold(s: string): string {
  return s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/"[^"]*"|\([^)]*\)/g, ' ')   // nicknames
    .replace(/-/g, ' ')
    .replace(/[^a-z\s,]/g, '')
    .replace(/\s+/g, ' ').trim()
}

const lastToken = (s: string) => s.split(' ').filter(Boolean).at(-1) ?? ''
const firstToken = (s: string) => s.split(' ').filter(Boolean)[0] ?? ''

/** A person's last name, and first name or initial (null when the record gives neither), folded for comparison. */
export function nameParts(p: PersonFacts): { first: string | null; last: string } {
  if (p.lastName && fold(p.lastName)) {
    return { last: lastToken(fold(p.lastName).replace(/,/g, '')), first: firstToken(fold(p.firstName ?? '').replace(/,/g, '')) || null }
  }
  let name = p.name.trim()
  for (let prev = ''; prev !== name;) { prev = name; name = name.replace(TITLE, '') }
  name = fold(name.replace(SUFFIX, ''))
  const comma = name.indexOf(',')
  if (comma >= 0) {
    return { last: lastToken(name.slice(0, comma)), first: firstToken(name.slice(comma + 1).replace(/,/g, '')) || null }
  }
  const tokens = name.split(' ').filter(Boolean)
  return { last: tokens.at(-1) ?? '', first: tokens.length > 1 ? tokens[0] : null }
}

/** 'upper' or 'lower' from a role id (LegiScan's 1 and 2) or a role's title, or null for a unicameral body or no role. */
export function chamberOf(p: PersonFacts): 'upper' | 'lower' | null {
  if (p.roleId === 1) return 'lower'
  if (p.roleId === 2) return 'upper'
  const role = (p.role ?? '').toLowerCase()
  if (/^(rep|del|assembly|house)/.test(role)) return 'lower'
  if (/^sen/.test(role)) return 'upper'
  return null
}

/** "HD-012" → "12", "Ward 1" → "1", or the folded text when there's no number. Null when blank. */
export function districtOf(p: PersonFacts): string | null {
  const d = (p.district ?? '').trim().toLowerCase()
  if (!d) return null
  const m = /(\d+)([a-z]?)\s*$/.exec(d)
  return m ? `${Number(m[1])}${m[2]}` : d.replace(/[^a-z0-9]/g, '')
}

/** A person's Bioguide id, compared without case or spaces, or null when blank. */
export function bioguideOf(p: PersonFacts): string | null {
  return p.bioguideId?.trim().toUpperCase() || null
}

type Tier = NonNullable<PersonMatch<PersonFacts, PersonFacts>['name']>

function sameName(tier: Tier, a: { first: string | null; last: string }, b: { first: string | null; last: string }): boolean {
  if (!a.last || a.last !== b.last) return false
  if (tier === 'full') return !!a.first && !!b.first && a.first.length > 1 && a.first === b.first
  if (tier === 'initial') return !!a.first && !!b.first && a.first[0] === b.first[0]
  return !a.first || !b.first
}

/**
 * Match legislators across two providers of one state. Two people with the
 * same Bioguide id match on it alone, strongly, before anything else is
 * compared. A Bioguide id people on one side share matches no one when the
 * other side has it too, and they're left out of the name comparisons as well.
 * When the other side lacks it, it's flagged and decides nothing.
 *
 * Everyone else is matched on name, chamber, and district: each compared only
 * where both records have it, and any that disagree rule a pair out, as two
 * different Bioguide ids do. One side having a Bioguide id the other lacks
 * doesn't. Names are tried closest first (whole names, then
 * last name and first initial, then last name alone where a record has no
 * first name), and a pair counts only when each is the other's one candidate,
 * so two Smiths in one chamber match no one. People left out that way are out
 * of the looser tiers too, on both sides. Maryland's feed names members by
 * last name alone and Virginia's has no districts, so their matches are weak:
 * reported as such, and still kept.
 */
export function matchPeople<A extends PersonFacts, B extends PersonFacts>(from: A[], to: B[]): PeopleMatch<A, B> {
  const facts = new Map<PersonFacts, { names: { first: string | null; last: string }; chamber: string | null; district: string | null; bioguide: string | null }>()
  for (const p of [...from, ...to]) facts.set(p, { names: nameParts(p), chamber: chamberOf(p), district: districtOf(p), bioguide: bioguideOf(p) })
  const compatible = (a: PersonFacts, b: PersonFacts) => {
    const fa = facts.get(a)!, fb = facts.get(b)!
    return (!fa.chamber || !fb.chamber || fa.chamber === fb.chamber)
      && (!fa.district || !fb.district || fa.district === fb.district)
      && (!fa.bioguide || !fb.bioguide || fa.bioguide === fb.bioguide)
  }
  const related = (tier: Tier, a: PersonFacts, b: PersonFacts) => sameName(tier, facts.get(a)!.names, facts.get(b)!.names) && compatible(a, b)

  const freeFrom = new Set(from)
  const freeTo = new Set(to)
  const matchedFrom = new Set<A>()
  const matched: PersonMatch<A, B>[] = []
  const ambiguous: PeopleMatch<A, B>['ambiguous'] = []
  const sharedBioguide: PeopleMatch<A, B>['sharedBioguide'] = []

  // Bioguide ids first, like a bill's match key: one person on each side
  // matches, and an id people on one side share matches no one the other
  // side's holders of it could be. With no holders there, it decides nothing.
  const byBioguide = <P extends PersonFacts>(list: P[]) => {
    const out = new Map<string, P[]>()
    for (const p of list) {
      const id = facts.get(p)!.bioguide
      if (id) out.set(id, [...(out.get(id) ?? []), p])
    }
    return out
  }
  const fromById = byBioguide(from)
  const toById = byBioguide(to)
  for (const id of new Set([...fromById.keys(), ...toById.keys()])) {
    const olds = fromById.get(id) ?? []
    const news = toById.get(id) ?? []
    if (olds.length === 1 && news.length === 1) {
      matched.push({ from: olds[0], to: news[0], name: null, on: ['bioguide'], weak: false })
      matchedFrom.add(olds[0])
      freeFrom.delete(olds[0])
      freeTo.delete(news[0])
      continue
    }
    if (olds.length <= 1 && news.length <= 1) continue
    if (olds.length > 1) sharedBioguide.push({ side: 'old', bioguideId: id, people: olds })
    if (news.length > 1) sharedBioguide.push({ side: 'new', bioguideId: id, people: news })
    if (olds.length === 0 || news.length === 0) continue
    for (const o of olds) freeFrom.delete(o)
    for (const p of news) {
      freeTo.delete(p)
      ambiguous.push({ person: p, candidates: olds })
    }
  }

  for (const tier of ['full', 'initial', 'last'] as const) {
    // Each tier reads who is still free at its start, so the order people
    // are listed in decides nothing.
    const candidatesOf = new Map([...freeTo].map(person => [person, [...freeFrom].filter(o => related(tier, o, person))]))
    const fits = new Map<A, number>()
    for (const candidates of candidatesOf.values()) for (const o of candidates) fits.set(o, (fits.get(o) ?? 0) + 1)
    for (const [person, candidates] of candidatesOf) {
      if (candidates.length === 0) continue
      // Not each other's one candidate: the new person and every candidate are
      // left out, so a looser tier can't guess between them either.
      if (candidates.length > 1 || fits.get(candidates[0])! > 1) {
        ambiguous.push({ person, candidates })
        freeTo.delete(person)
        for (const o of candidates) freeFrom.delete(o)
        continue
      }
      const o = candidates[0]
      const fo = facts.get(o)!, fp = facts.get(person)!
      const on: MatchedOn[] = ['name']
      if (fo.chamber && fp.chamber) on.push('chamber')
      if (fo.district && fp.district) on.push('district')
      matched.push({ from: o, to: person, name: tier, on, weak: !(on.includes('chamber') && on.includes('district')) })
      matchedFrom.add(o)
      freeFrom.delete(o)
      freeTo.delete(person)
    }
  }
  return { matched, ambiguous, unmatchedFrom: from.filter(p => !matchedFrom.has(p)), unmatchedTo: [...freeTo], sharedBioguide }
}
