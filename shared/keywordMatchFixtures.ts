/**
 * Input/expectation rows shared by both keyword matchers' tests.
 *
 * central/src/lib/keywords.ts (matchesUnion) and api/src/lib/keywords.ts
 * (matchesKeywords) are both re-exports of shared/keywords.ts — the single
 * implementation. Nothing enforces that a caller keeps re-exporting it, so
 * this fixture table still exists to prove both packages' test suites assert
 * against the same behavior.
 *
 * Each package's test suite asserts ITS OWN matcher against this one table, so
 * a change to either side that is not mirrored fails that side's tests.
 */

export type KeywordMatchCase = { text: string; keywords: string[]; expected: boolean }

export const KEYWORD_MATCH_CASES: KeywordMatchCase[] = [
  // Wildcard, sole entry only
  { text: 'Tobacco Amendments', keywords: ['*'], expected: true },
  { text: '', keywords: ['*'], expected: true },
  { text: 'Tobacco Amendments', keywords: ['*', 'county'], expected: false },
  { text: 'County Budget', keywords: ['*', 'county'], expected: true },
  { text: 'Tobacco Amendments', keywords: [], expected: false },

  // Exact word is the default
  { text: 'County Budget Amendments', keywords: ['county'], expected: true },
  { text: 'COUNTY BUDGET AMENDMENTS', keywords: ['county'], expected: true },
  { text: 'Countywide reassessment', keywords: ['county'], expected: false },
  { text: 'Election Law Amendments', keywords: ['election'], expected: true },
  { text: 'Selection of a provider', keywords: ['election'], expected: false },
  { text: 'General elections calendar', keywords: ['election'], expected: false },

  // Trailing star: word start
  { text: 'General elections calendar', keywords: ['election*'], expected: true },
  { text: 'Election Law Amendments', keywords: ['election*'], expected: true },
  { text: 'Selection of a provider', keywords: ['election*'], expected: false },

  // Leading star: word end
  { text: 'A lien on real property', keywords: ['*lien'], expected: true },
  { text: 'Resilient infrastructure grants', keywords: ['*lien'], expected: false },

  // Both stars: anywhere
  { text: 'Incorporated municipalities', keywords: ['*corporat*'], expected: true },
  { text: 'Resilient infrastructure grants', keywords: ['*lien*'], expected: true },

  // Boundaries and escaping
  { text: 'mail-in ballot application', keywords: ['ballot'], expected: true },
  { text: 'the election.', keywords: ['election'], expected: true },
  // A digit is INSIDE a token, so it blocks a boundary exactly as a letter does.
  // This row asserted `true` while the boundary class was letters-only.
  { text: 'election2024 results', keywords: ['election'], expected: false },
  { text: 'election2024 results', keywords: ['election*'], expected: true },
  { text: 'Vehicle registration fee increase', keywords: ['ballot'], expected: false },
  { text: 'section 132 applies', keywords: ['1.2'], expected: false },

  // Statute citations. Bill descriptions lead with the sections a bill affects
  // ("An Act to amend 6.86 (1) (a) 2.; to create 5.02 of the statutes; Relating
  // to: ..."), so a chapter is a usable intake signal without reading bill text.
  // A digit-blocking boundary is what makes it expressible: chapter 5 must not
  // match section 115.385 of some other chapter.
  { text: 'An Act to amend 5.02 of the statutes', keywords: ['5.#*'], expected: true },
  { text: 'An Act to amend 115.385 of the statutes', keywords: ['5.#*'], expected: false },
  { text: 'An Act to amend 45.44 of the statutes', keywords: ['5.#*'], expected: false },
  // The subdivision at the tail of a citation is "5." followed by punctuation.
  // `#` requires a digit there, which is what separates a chapter from a
  // subdivision — an unanchored `5.*` matches both.
  { text: 'An Act to amend 115.385 (1) (b) 5., 6.30', keywords: ['5.#*'], expected: false },
  { text: 'An Act to amend 115.385 (1) (b) 5., 6.30', keywords: ['5.*'], expected: true },
  { text: 'to renumber 59.52 (1)', keywords: ['59.#*'], expected: true },
  { text: 'to repeal 765.001 (2)', keywords: ['765.#*'], expected: true },
  // `#` matches exactly one digit, and is a literal nowhere else.
  { text: 'section 5.02', keywords: ['5.##'], expected: true },
  { text: 'section 5.0', keywords: ['5.##'], expected: false },
  { text: 'ranked #1 priority', keywords: ['#1'], expected: false },
  // An exact section cite stays exact: 19.85 is a different section from 19.851.
  { text: 'to amend 19.85 (1) (c)', keywords: ['19.85'], expected: true },
  { text: 'to amend 19.851 (1)', keywords: ['19.85'], expected: false },

  // Degenerate entries
  { text: 'Election Law Amendments', keywords: ['', '  '], expected: false },
]

/**
 * A bill as the keyword matcher sees it: the three fields that make up its
 * match text (see `billMatchText` in shared/keywords.ts).
 *
 * `description` is central's `bills.description`. The instance stores the same
 * text under the name `abstract` (central's /bills route returns it as
 * `abstract: bill.description`), so instance-side callers pass their `abstract`
 * column as `description`.
 */
export type KeywordMatchBill = {
  title: string
  description: string | null
  billNumber: string
}

export type BillKeywordMatchCase = {
  /** What the case proves, for the test name. */
  name: string
  bill: KeywordMatchBill
  keywords: string[]
  expected: boolean
}

/**
 * Whole-bill rows: keywords against title + description + bill number. Every
 * suite runs each row through central's or the instance's real match path, so
 * a keyword that central matches but the instance predicts differently (or the
 * reverse) fails a test.
 *
 * Bill numbers are spelled the way providers return them ("HB 1019").
 */
export const BILL_KEYWORD_MATCH_CASES: BillKeywordMatchCase[] = [
  {
    name: 'a keyword in the title only',
    bill: { title: 'Ballot Access Act', description: 'Concerns polling places.', billNumber: 'HB 1019' },
    keywords: ['ballot'],
    expected: true,
  },
  {
    name: 'a keyword in the description only',
    bill: { title: 'Gaming matters.', description: 'Concerns absentee voting procedures.', billNumber: 'HB 1038' },
    keywords: ['absentee'],
    expected: true,
  },
  {
    // The whole bug: the instance used to read title + abstract only.
    name: 'a keyword in the bill number only',
    bill: { title: 'Bridge naming.', description: 'Names a bridge in the county.', billNumber: 'HB 1019' },
    keywords: ['hb 1019'],
    expected: true,
  },
  {
    name: 'a bill-number glob matches across the prefix',
    bill: { title: 'Bridge naming.', description: null, billNumber: 'HB 1019' },
    keywords: ['hb*'],
    expected: true,
  },
  {
    name: 'a bill number is a whole token, so HB 101 does not match HB 1019',
    bill: { title: 'Bridge naming.', description: null, billNumber: 'HB 1019' },
    keywords: ['hb 101'],
    expected: false,
  },
  {
    name: 'a missing description leaves title and number intact',
    bill: { title: 'Ballot Access Act', description: null, billNumber: 'SB 7' },
    keywords: ['sb 7'],
    expected: true,
  },
  {
    name: 'a keyword in none of the three fields',
    bill: { title: 'Bridge naming.', description: 'Names a bridge.', billNumber: 'HB 1019' },
    keywords: ['ballot'],
    expected: false,
  },
  {
    // Fields are joined by a space, so a token cannot straddle two of them.
    name: 'a keyword cannot match across the title and bill number boundary',
    bill: { title: 'Relating to HB', description: null, billNumber: '1019' },
    keywords: ['hb1019'],
    expected: false,
  },
  {
    name: 'the match-all keyword matches a bill with no other text',
    bill: { title: '', description: null, billNumber: 'HB 1' },
    keywords: ['*'],
    expected: true,
  },
  {
    name: 'an empty list matches nothing',
    bill: { title: 'Ballot Access Act', description: null, billNumber: 'HB 1' },
    keywords: [],
    expected: false,
  },
]
