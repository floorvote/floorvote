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
 * This is the DEFAULT, and it is truthful only for a deployment running this
 * code unmodified. An operator running a modified version must override it with
 * the `OPERATOR_SOURCE_URL` tenant var, which points at their own published
 * source; nothing at runtime can detect that they should have. Setting that var
 * to an empty string withdraws the offer, leaving the license notice in place
 * without a link.
 */
export const SOURCE_URL = 'https://github.com/floorvote/floorvote'
