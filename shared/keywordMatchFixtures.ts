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
 * The one-off scripts no longer hand-copy the logic — load-history.ts,
 * seed-from-bulk.ts, openstates-eval.ts and openstates-deep-eval.ts all import
 * from shared/keywords.ts, so a matcher change reaches them without edits.
 * (This comment claimed otherwise until 2026-09-10, when auditing the blast
 * radius of a boundary-class change turned up the imports.) The two eval
 * scripts still match against their own hard-coded keyword list rather than an
 * operator-supplied one, so the wildcard sentinel can never reach them.
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
