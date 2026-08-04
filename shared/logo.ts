import { fontWeight } from './tokens'

/**
 * The FloorVote logo mark — a stylized legislative hemicycle (three concentric
 * rows of chamber seating). SINGLE SOURCE OF TRUTH for the mark geometry; every
 * surface (app SVG, docs SVG, generated favicon/app-icon/email rasters) derives
 * from this.
 *
 * v1.1: the sections are drawn as FILLED ring-segments whose aisle edges are cut
 * along straight lines a fixed half-width from the centerline ray — constant-width
 * channels, not angular wedges. (v1.0 was stroked open arcs; the mark is now
 * `fill`, never `stroke`.) The playground export's scale transform is baked into
 * the coordinates, so no transform attribute is needed.
 */
export const LOGO_MARK = {
  /** Framed box with clear-space margin — standalone mark, favicon, email PNG. */
  viewBox: '20 25.6 60 42',
  /**
   * Tight crop to the visible artwork (arch apex → leg bottoms), for the inline
   * lockup: `height` is then the visible height and `vertical-align: baseline`
   * seats the legs on the text baseline. See DESIGN-PRINCIPLES in the brand kit.
   */
  inlineViewBox: '21.2 26.832 57.6 37.938',
  paths: [
    // Row 1 — outer (r 28.8 → 24)
    'M 22.69 64.77 A 28.8 28.8 0 0 1 22.92 45.83 L 27.36 47.67 A 24 24 0 0 0 27.24 63.25 Z M 23.93 43.39 A 28.8 28.8 0 0 1 37.78 29.56 L 39.61 34 A 24 24 0 0 0 28.37 45.23 Z M 40.22 28.55 A 28.8 28.8 0 0 1 59.78 28.55 L 57.95 32.99 A 24 24 0 0 0 42.05 32.99 Z M 62.22 29.56 A 28.8 28.8 0 0 1 76.07 43.39 L 71.63 45.23 A 24 24 0 0 0 60.39 34 Z M 77.08 45.83 A 28.8 28.8 0 0 1 77.31 64.77 L 72.76 63.25 A 24 24 0 0 0 72.64 47.67 Z',
    // Row 2 — middle (r 21.6 → 16.8)
    'M 29.52 62.49 A 21.6 21.6 0 0 1 29.58 48.59 L 34.03 50.43 A 16.8 16.8 0 0 0 34.07 60.96 Z M 30.59 46.15 A 21.6 21.6 0 0 1 40.53 36.22 L 42.37 40.66 A 16.8 16.8 0 0 0 35.04 48 Z M 42.97 35.21 A 21.6 21.6 0 0 1 57.03 35.21 L 55.19 39.65 A 16.8 16.8 0 0 0 44.81 39.65 Z M 59.47 36.22 A 21.6 21.6 0 0 1 69.41 46.15 L 64.96 48 A 16.8 16.8 0 0 0 57.63 40.66 Z M 70.42 48.59 A 21.6 21.6 0 0 1 70.48 62.49 L 65.93 60.96 A 16.8 16.8 0 0 0 65.97 50.43 Z',
    // Row 3 — inner (r 14.4 → 9.6)
    'M 36.34 60.2 A 14.4 14.4 0 0 1 36.25 51.36 L 40.71 53.21 A 9.6 9.6 0 0 0 40.9 58.68 Z M 37.26 48.92 A 14.4 14.4 0 0 1 43.3 42.89 L 45.14 47.35 A 9.6 9.6 0 0 0 41.72 50.77 Z M 45.73 41.88 A 14.4 14.4 0 0 1 54.27 41.88 L 52.42 46.34 A 9.6 9.6 0 0 0 47.58 46.34 Z M 56.7 42.89 A 14.4 14.4 0 0 1 62.74 48.92 L 58.28 50.77 A 9.6 9.6 0 0 0 54.86 47.35 Z M 63.75 51.36 A 14.4 14.4 0 0 1 63.66 60.2 L 59.1 58.68 A 9.6 9.6 0 0 0 59.29 53.21 Z',
  ],
} as const

/**
 * The wordmark lockup metrics — how the mark sits left of the "FloorVote" text.
 * Expressed in em so one spec scales across every surface. Colors come from
 * tokens.ts (accentAmber / billBadgeNavy); never re-hardcode them.
 *
 * v1.1: the mark is sized to the caps (a peer of "F"/"V"), not to the tall "l".
 * With the tight `inlineViewBox`, `markHeightEm` is the visible height and the
 * legs seat on the baseline — no optical up-nudge needed.
 */
export const LOGO_LOCKUP = {
  markHeightEm: 0.698, // 1.02 × Archivo cap-height — round top reaches the O-overshoot line
  gapEm: 0.343, // 0.5 × cap-height (≈ two word-spaces)
  letterSpacing: '-0.02em',
  weight: fontWeight.heavy, // 600 — the app is the brand source of truth
} as const

/** Standalone transparent mark as an SVG string. `fill` defaults to Honey. */
export function logoMarkSvg(fill = '#e8a33d'): string {
  const paths = LOGO_MARK.paths.map((d) => `<path d="${d}"/>`).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${LOGO_MARK.viewBox}" fill="${fill}">${paths}</svg>`
}
