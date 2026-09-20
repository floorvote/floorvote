/**
 * Cross-cutting window event names.
 *
 * Deliberately its own module rather than living in `lib/api`: that module is
 * mocked by a dozen test files, and a constant exported from it forces every one
 * of them to re-declare the constant or blow up at render. A module nobody needs
 * to mock costs nothing to import from either side.
 */

/**
 * Fired when any request comes back gated on terms acceptance. AuthProvider
 * listens and re-fetches /auth/me, which flips `termsAcceptanceRequired` and
 * puts the interstitial up.
 *
 * This is the stale-tab path: a tab open when LEGAL_TERMS_UPDATED is bumped
 * starts getting 403s from every route, and without this the first one surfaces
 * as a generic "something went wrong" instead of the screen that fixes it.
 */
export const TERMS_NOT_ACCEPTED_EVENT = 'terms-not-accepted'
