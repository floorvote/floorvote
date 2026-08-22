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
 * No trailing slash: OperatorBranding appends `/blob/main/LICENSE` to build the
 * license link. Setting this to an empty string hides the footer line entirely,
 * which withdraws that source offer — only appropriate for a fork whose source
 * is not published at a public URL.
 */
export const SOURCE_URL = 'https://github.com/floorvote/floorvote'
