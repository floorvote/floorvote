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
 *
 * There are further hand-copies of the same logic in one-off scripts, which no
 * test covers — keep them in step by hand when the matcher changes. This is
 * the inventory of the TypeScript copies only, not a claim to have found every
 * hand-copy in the repo:
 *   scripts/openstates/load-history.ts      (matchesUnion — has the wildcard)
 *   scripts/openstates/seed-from-bulk.ts    (kwMatch — has the wildcard;
 *                                            takes operator --keywords)
 *   scripts/openstates/openstates-eval.ts   (matchesKeywords — no wildcard,
 *                                            hard-coded ELECTION_KEYWORDS list,
 *                                            takes no operator keywords)
 *   scripts/openstates/openstates-deep-eval.ts  (same as openstates-eval.ts)
 *
 * The two eval scripts deliberately omit the wildcard: they match against their
 * own hard-coded keyword list and never see an operator-supplied one, so the
 * sentinel can never reach them.
 *
 * scripts/openstates/openstates-crossref.py is a SEPARATE, deliberate
 * divergence and is not tracked here: it's a Python, offline-only script that
 * cannot import this TypeScript module, so it keeps its own copy — a
 * `WORD_BOUNDARY = {'election'}` carve-out plus plain substring matching, i.e.
 * the OLD pre-glob semantics this file replaced everywhere else. It was never
 * ported to glob syntax and its match counts are not comparable to any of the
 * matchers above.
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
  { text: 'election2024 results', keywords: ['election'], expected: true },
  { text: 'Vehicle registration fee increase', keywords: ['ballot'], expected: false },
  { text: 'section 132 applies', keywords: ['1.2'], expected: false },

  // Degenerate entries
  { text: 'Election Law Amendments', keywords: ['', '  '], expected: false },
]
