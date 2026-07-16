/**
 * The product name — the single source of truth, consumed by the web frontend,
 * the tenant API (`api/`), and the central worker (`central/`).
 *
 * The two-tone wordmark renders `PRODUCT_NAME_WORDMARK.primary` ("Floor") and
 * `PRODUCT_NAME_WORDMARK.accent` ("Vote") in different colors; concatenated they
 * equal `PRODUCT_NAME`.
 */
export const PRODUCT_NAME = 'FloorVote'

export const PRODUCT_NAME_WORDMARK = { primary: 'Floor', accent: 'Vote' } as const

/**
 * Public source repository URL, surfaced as a "Source (AGPLv3)" link in the app
 * footer to satisfy AGPLv3 §13 — the offer of Corresponding Source to users who
 * interact with the software over a network.
 *
 * Empty while the repository is private, so the footer link stays hidden. Set
 * this to the public repository URL in the same commit that makes the repo
 * public (a deliberate, one-time flip — see docs/backlog.md open-source hygiene).
 */
export const SOURCE_URL = ''
