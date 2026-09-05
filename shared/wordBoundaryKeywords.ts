/**
 * Keywords that must match on a word boundary rather than as a bare substring.
 *
 * SINGLE SOURCE OF TRUTH. This set used to be a literal in each of the two
 * hand-mirrored matchers (central/src/lib/keywords.ts and api/src/lib/keywords.ts),
 * which meant adding a member to one and not the other left both test suites
 * green while the matchers genuinely disagreed. The matching LOGIC is still
 * mirrored by hand and pinned by shared/keywordMatchFixtures.ts; the membership
 * list lives here so it cannot drift at all.
 *
 * Adding a member here automatically adds a pair of boundary rows to the shared
 * fixture table, so both suites exercise the new keyword.
 */
export const WORD_BOUNDARY_KEYWORDS = new Set(['election'])
