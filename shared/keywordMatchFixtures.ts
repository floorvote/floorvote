/**
 * Input/expectation rows shared by both keyword matchers' tests.
 *
 * central/src/lib/keywords.ts (matchesUnion) and api/src/lib/keywords.ts
 * (matchesKeywords) are hand-mirrored: two separate Workers with no shared
 * module between them. Nothing enforces that they stay in sync, and a
 * divergence is silent and serious — central decides which bills to link and
 * fetch, the tenant decides which to analyze, so disagreement means the tenant
 * analyzes a different set than central delivered.
 *
 * Each package's test suite asserts ITS OWN matcher against this one table, so
 * a change to either side that is not mirrored fails that side's tests.
 */
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
]
