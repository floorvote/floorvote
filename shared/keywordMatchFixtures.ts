/**
 * Input/expectation rows shared by both keyword matchers' tests.
 *
 * central/src/lib/keywords.ts (matchesUnion) and api/src/lib/keywords.ts
 * (matchesKeywords) are hand-mirrored: two separate Workers with no shared
 * matching module between them. Nothing enforces that the logic stays in sync,
 * and a divergence is silent and serious — central decides which bills to link
 * and fetch, the tenant decides which to analyze, so disagreement means the
 * tenant analyzes a different set than central delivered.
 *
 * Each package's test suite asserts ITS OWN matcher against this one table, so
 * a change to either side that is not mirrored fails that side's tests.
 *
 * There are further hand-copies of the same logic in one-off scripts, which no
 * test covers — keep them in step by hand when the matcher changes. The full
 * inventory, verified by grepping for WORD_BOUNDARY_KEYWORDS across the repo:
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
 */
import { WORD_BOUNDARY_KEYWORDS } from './wordBoundaryKeywords'

export type KeywordMatchCase = { text: string; keywords: string[]; expected: boolean }

export const KEYWORD_MATCH_CASES: KeywordMatchCase[] = [
  { text: 'Tobacco Amendments', keywords: ['*'], expected: true },
  { text: '', keywords: ['*'], expected: true },
  { text: 'Tobacco Amendments', keywords: ['*', 'county'], expected: true },
  { text: 'Tobacco Amendments', keywords: [], expected: false },
  { text: 'Tobacco Amendments', keywords: ['*extra'], expected: false },
  { text: 'County Budget Amendments', keywords: ['county'], expected: true },
  { text: 'COUNTY BUDGET AMENDMENTS', keywords: ['county'], expected: true },
  { text: 'Selection of a provider', keywords: ['election'], expected: false },
  { text: 'Election Law Amendments', keywords: ['election'], expected: true },
  { text: 'Vehicle registration fee increase', keywords: ['ballot'], expected: false },
  // One pair per WORD_BOUNDARY_KEYWORDS member, generated so that adding a
  // member to the shared set automatically extends both suites: preceded by a
  // letter it must NOT match, standing alone it MUST match.
  ...[...WORD_BOUNDARY_KEYWORDS].flatMap((kw): KeywordMatchCase[] => [
    { text: `A bill on the pre${kw} process`, keywords: [kw], expected: false },
    { text: `A bill on the ${kw} process`, keywords: [kw], expected: true },
  ]),
]
