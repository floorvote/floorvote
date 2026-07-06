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
