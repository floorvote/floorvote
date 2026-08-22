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
 * The license the work is under, and the canonical address of its text.
 *
 * Deliberately NOT operator-configurable, unlike `OPERATOR_SOURCE_URL` below. A
 * derivative of AGPL-3.0 code stays AGPL-3.0, so the license is a property of
 * the work rather than of whoever deploys it; a config knob here could only
 * ever let an operator mislabel it. The address is gnu.org rather than a copy
 * inside some repository, because the license text is identical everywhere and
 * a repo-relative path has to guess the host's URL shape and default branch —
 * which is exactly how the old `${sourceUrl}/blob/main/LICENSE` link broke for
 * anyone not on GitHub.
 */
export const LICENSE_NAME = 'AGPLv3'

export const LICENSE_URL = 'https://www.gnu.org/licenses/agpl-3.0.html'

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
