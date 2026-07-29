import { fontWeight } from './tokens'

/**
 * The FloorVote logo mark — a stylized legislative hemicycle (three concentric
 * rows of chamber seating). SINGLE SOURCE OF TRUTH for the mark geometry; every
 * surface (app SVG, docs SVG, generated favicon/app-icon/email rasters) derives
 * from this. Transform from the playground export is baked into the coordinates,
 * so no transform attribute is needed. Verified pixel-identical to the export.
 */
export const LOGO_MARK = {
  viewBox: '20 25.6 60 42',
  strokeWidth: 4.8,
  paths: [
    // Row 1 — outer (r=26.4)
    'M24.96 64.01A26.4 26.4 0 0 1 24.96 47.26M26.37 43.85A26.4 26.4 0 0 1 38.22 32.01M41.62 30.6A26.4 26.4 0 0 1 58.38 30.6M61.78 32.01A26.4 26.4 0 0 1 73.63 43.85M75.04 47.26A26.4 26.4 0 0 1 75.04 64.01',
    // Row 2 — middle (r=19.2)
    'M31.79 61.72A19.2 19.2 0 0 1 31.79 49.54M32.82 47.07A19.2 19.2 0 0 1 41.43 38.45M43.91 37.42A19.2 19.2 0 0 1 56.09 37.42M58.57 38.45A19.2 19.2 0 0 1 67.18 47.07M68.21 49.54A19.2 19.2 0 0 1 68.21 61.72',
    // Row 3 — inner (r=12)
    'M38.62 59.44A12 12 0 0 1 38.62 51.82M39.26 50.28A12 12 0 0 1 44.65 44.89M46.19 44.25A12 12 0 0 1 53.81 44.25M55.35 44.89A12 12 0 0 1 60.74 50.28M61.38 51.82A12 12 0 0 1 61.38 59.44',
  ],
} as const

/**
 * The wordmark lockup metrics — how the mark sits left of the "FloorVote" text.
 * Expressed in em so one spec scales across every surface. Colors come from
 * tokens.ts (accentAmber / billBadgeNavy); never re-hardcode them.
 */
export const LOGO_LOCKUP = {
  markHeightEm: 0.83, // ~115% of Archivo cap-height
  gapEm: 0.29,
  markShiftY: '-2.5%', // nudge the mark up 2.5% of its own height for optical balance
  letterSpacing: '-0.02em',
  weight: fontWeight.heavy, // 600 — the app is the brand source of truth
} as const

/** Standalone transparent mark as an SVG string. `stroke` defaults to Honey. */
export function logoMarkSvg(stroke = '#e8a33d'): string {
  const paths = LOGO_MARK.paths.map((d) => `<path d="${d}"/>`).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${LOGO_MARK.viewBox}" fill="none" stroke="${stroke}" stroke-width="${LOGO_MARK.strokeWidth}">${paths}</svg>`
}
