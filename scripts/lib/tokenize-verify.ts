/**
 * tokenize-verify — pure functions for verifying that a style-token migration
 * only changes values via approved canonical consolidations.
 *
 * See docs/style-token-decisions.md for the approved collapse tables.
 */

// ---------------------------------------------------------------------------
// Hex normalisation
// ---------------------------------------------------------------------------

/**
 * Normalize a hex color to 6-digit lowercase.
 * '#FFF' -> '#ffffff', '#Abcdef' -> '#abcdef'.
 * Assumes the input is already a valid 3- or 6-digit hex with leading '#'.
 */
export function normHex(hex: string): string {
  const digits = hex.slice(1).toLowerCase()
  if (digits.length === 3) {
    return '#' + digits[0] + digits[0] + digits[1] + digits[1] + digits[2] + digits[2]
  }
  return '#' + digits
}

// ---------------------------------------------------------------------------
// Color canonical map
// ---------------------------------------------------------------------------

/**
 * Approved color consolidations (absorbed -> canonical).
 * All keys and values are 6-digit lowercase hex.
 * Source: docs/style-token-decisions.md § Colors.
 */
const COLOR_CANON: Record<string, string> = {
  '#e8edf2': '#e2e8f0',
  '#e8ecf1': '#e2e8f0',
  '#9ca3af': '#94a3b8',
  '#334155': '#374151',
  '#d1d5db': '#cbd5e1',
  '#fef9c3': '#fef3c7',
  '#ffe4e6': '#fee2e2',
  '#f3e8ff': '#ede9fe',
  '#dbeafe': '#e0f2fe',
  '#ffffff': '#ffffff',
  '#fafafa': '#ffffff',  // white absorbs fafafa
  '#eef2f7': '#f1f5f9',
  '#f8f8f7': '#f1f5f9',
  '#ebf3ff': '#eff6ff',
  '#eef2ff': '#eff6ff',
  '#fef2f2': '#fff5f5',
}

/**
 * Return the canonical hex for a given hex color (normHex'd), or the
 * normalized value itself if it's not in the consolidation map.
 */
export function canonicalColor(hex: string): string {
  const norm = normHex(hex)
  return COLOR_CANON[norm] ?? norm
}

// ---------------------------------------------------------------------------
// Radius canonical map
// ---------------------------------------------------------------------------

const RADIUS_CANON: Record<number, number> = {
  1: 2,
  2: 2,
  3: 4,
  4: 4,
  5: 4,
  6: 6,
  7: 6,
  8: 8,
  10: 8,
  12: 12,
  20: 12,
  99: 999,
  999: 999,
}

/** Collapse a border-radius value to its canonical tier (identity if not listed). */
export function canonicalRadius(n: number): number {
  return RADIUS_CANON[n] ?? n
}

// ---------------------------------------------------------------------------
// Font-size canonical map
// ---------------------------------------------------------------------------

const FONT_SIZE_CANON: Record<number, number> = {
  9: 10,
  10: 10,
  11: 12,
  12: 12,
  13: 12,
  14: 14,
  15: 14,
}

/** Collapse a font-size value to its canonical tier (identity if not listed). */
export function canonicalFontSize(n: number): number {
  return FONT_SIZE_CANON[n] ?? n
}

// ---------------------------------------------------------------------------
// Value extraction
// ---------------------------------------------------------------------------

export interface AxisValues {
  colors: string[]     // normHex'd 6-digit lowercase
  radii: number[]
  fontSizes: number[]
  fontWeights: number[]
}

/**
 * CSS named colors that may appear in inline style values, mapped to their
 * canonical hex equivalents. Extend if needed.
 */
const CSS_NAMED_COLORS: Record<string, string> = {
  white:       '#ffffff',
  black:       '#000000',
  transparent: '#000000', // transparent is special; exclude from color accounting
}

/**
 * Extract raw style values from the ORIGINAL (pre-migration) source text.
 *
 * - colors: every /#[0-9a-fA-F]{3,8}\b/ that is exactly 3 or 6 hex digits
 *   (after stripping the #). Alpha (4/8-digit) are skipped.
 *   Also captures CSS named color keywords (e.g. `'white'`) and converts them
 *   to their hex equivalents so they round-trip correctly with token migrations.
 * - radii: every `borderRadius: <int>` literal.
 * - fontSizes: every `fontSize: <int>` literal.
 * - fontWeights: every `fontWeight: <int>` literal.
 */
export function extractOld(src: string): AxisValues {
  const colors: string[] = []
  const hexRe = /#([0-9a-fA-F]{3,8})\b/g
  let m: RegExpExecArray | null
  while ((m = hexRe.exec(src)) !== null) {
    const digits = m[1]
    if (digits.length === 3 || digits.length === 6) {
      colors.push(normHex('#' + digits))
    }
    // 4 / 8 digit (alpha) are intentionally skipped
  }

  // CSS named color keywords in string literals (e.g. background: 'white')
  const namedColorRe = /:\s*['"`](white|black)['"`]/g
  let nm: RegExpExecArray | null
  while ((nm = namedColorRe.exec(src)) !== null) {
    const hex = CSS_NAMED_COLORS[nm[1]]
    if (hex) colors.push(hex)
  }

  const radii = [...src.matchAll(/borderRadius:\s*(\d+)/g)].map(r => parseInt(r[1], 10))
  const fontSizes = [...src.matchAll(/fontSize:\s*(\d+)/g)].map(r => parseInt(r[1], 10))
  const fontWeights = [...src.matchAll(/fontWeight:\s*(\d+)/g)].map(r => parseInt(r[1], 10))

  return { colors, radii, fontSizes, fontWeights }
}

// ---------------------------------------------------------------------------

export interface TokenMaps {
  color: Record<string, string | number>
  radius: Record<string, number>
  fontSize: Record<string, number>
  fontWeight: Record<string, number>
}

/**
 * Extract values from the MIGRATED source, resolving token references via the
 * provided maps, PLUS any remaining raw literals.
 *
 * Token reference patterns:
 *   color:        /\bcolor\.([A-Za-z0-9_]+)/
 *   borderRadius: /borderRadius:\s*radius\.([A-Za-z0-9_]+)/
 *   fontSize:     /fontSize:\s*fontSize\.([A-Za-z0-9_]+)/
 *   fontWeight:   /fontWeight:\s*fontWeight\.([A-Za-z0-9_]+)/
 *
 * Remaining raw literals are also collected (same patterns as extractOld, but
 * skipping positions already consumed by token references).
 *
 * Throws an Error naming any referenced token that is absent from its map.
 */
export function extractNew(src: string, maps: TokenMaps): AxisValues {
  const colors: string[] = []
  const radii: number[] = []
  const fontSizes: number[] = []
  const fontWeights: number[] = []

  // Track consumed character ranges so raw-literal pass skips them.
  // We use a simple approach: collect token-ref intervals per axis, then
  // scan for raw literals only outside those intervals.

  // --- color tokens ---
  const colorTokenRe = /\bcolor\.([A-Za-z0-9_]+)/g
  const colorTokenSpans: [number, number][] = []
  let cm: RegExpExecArray | null
  while ((cm = colorTokenRe.exec(src)) !== null) {
    const name = cm[1]
    if (!(name in maps.color)) throw new Error(`Unknown color token: color.${name}`)
    const raw = maps.color[name] as string
    // The token value may be a shorthand like '#fff'; normalise it.
    colors.push(normHex(raw.startsWith('#') ? raw : '#' + raw))
    colorTokenSpans.push([cm.index, cm.index + cm[0].length])
  }

  // --- radius tokens ---
  const radiusTokenRe = /borderRadius:\s*radius\.([A-Za-z0-9_]+)/g
  const radiusTokenSpans: [number, number][] = []
  let rm: RegExpExecArray | null
  while ((rm = radiusTokenRe.exec(src)) !== null) {
    const name = rm[1]
    if (!(name in maps.radius)) throw new Error(`Unknown radius token: radius.${name}`)
    radii.push(maps.radius[name])
    radiusTokenSpans.push([rm.index, rm.index + rm[0].length])
  }

  // --- fontSize tokens ---
  const fontSizeTokenRe = /fontSize:\s*fontSize\.([A-Za-z0-9_]+)/g
  const fontSizeTokenSpans: [number, number][] = []
  let fm: RegExpExecArray | null
  while ((fm = fontSizeTokenRe.exec(src)) !== null) {
    const name = fm[1]
    if (!(name in maps.fontSize)) throw new Error(`Unknown fontSize token: fontSize.${name}`)
    fontSizes.push(maps.fontSize[name])
    fontSizeTokenSpans.push([fm.index, fm.index + fm[0].length])
  }

  // --- fontWeight tokens ---
  const fontWeightTokenRe = /fontWeight:\s*fontWeight\.([A-Za-z0-9_]+)/g
  const fontWeightTokenSpans: [number, number][] = []
  let wm: RegExpExecArray | null
  while ((wm = fontWeightTokenRe.exec(src)) !== null) {
    const name = wm[1]
    if (!(name in maps.fontWeight)) throw new Error(`Unknown fontWeight token: fontWeight.${name}`)
    fontWeights.push(maps.fontWeight[name])
    fontWeightTokenSpans.push([wm.index, wm.index + wm[0].length])
  }

  // --- raw literal: hex colors (outside color token spans) ---
  const hexRe = /#([0-9a-fA-F]{3,8})\b/g
  let hm: RegExpExecArray | null
  while ((hm = hexRe.exec(src)) !== null) {
    if (isInsideSpans(hm.index, colorTokenSpans)) continue
    const digits = hm[1]
    if (digits.length === 3 || digits.length === 6) {
      colors.push(normHex('#' + digits))
    }
  }

  // --- raw literal: borderRadius (outside radius token spans) ---
  const rawRadiusRe = /borderRadius:\s*(\d+)/g
  let rrm: RegExpExecArray | null
  while ((rrm = rawRadiusRe.exec(src)) !== null) {
    if (isInsideSpans(rrm.index, radiusTokenSpans)) continue
    radii.push(parseInt(rrm[1], 10))
  }

  // --- raw literal: fontSize (outside fontSize token spans) ---
  const rawFontSizeRe = /fontSize:\s*(\d+)/g
  let rfm: RegExpExecArray | null
  while ((rfm = rawFontSizeRe.exec(src)) !== null) {
    if (isInsideSpans(rfm.index, fontSizeTokenSpans)) continue
    fontSizes.push(parseInt(rfm[1], 10))
  }

  // --- raw literal: fontWeight (outside fontWeight token spans) ---
  const rawFontWeightRe = /fontWeight:\s*(\d+)/g
  let rwm: RegExpExecArray | null
  while ((rwm = rawFontWeightRe.exec(src)) !== null) {
    if (isInsideSpans(rwm.index, fontWeightTokenSpans)) continue
    fontWeights.push(parseInt(rwm[1], 10))
  }

  return { colors, radii, fontSizes, fontWeights }
}

function isInsideSpans(pos: number, spans: [number, number][]): boolean {
  return spans.some(([start, end]) => pos >= start && pos < end)
}

// ---------------------------------------------------------------------------
// Verify
// ---------------------------------------------------------------------------

export interface VerifyResult {
  ok: boolean
  problems: string[]
}

/**
 * Compare old and new source texts.
 *
 * For each axis:
 *   EXPECTED = multiset formed by mapping each OLD value through its canonical
 *              function (canonicalColor / canonicalRadius / canonicalFontSize;
 *              identity for fontWeight), with colors normHex'd.
 *   ACTUAL   = multiset from extractNew (colors already normHex'd).
 *
 * ok = every axis's expected multiset equals its actual multiset.
 * problems lists axis name + differing values on mismatch.
 */
export function verify(oldSrc: string, newSrc: string, maps: TokenMaps): VerifyResult {
  const old_ = extractOld(oldSrc)
  const new_ = extractNew(newSrc, maps)

  const problems: string[] = []

  // colors
  const expectedColors = old_.colors.map(c => canonicalColor(c))
  checkAxis('color', expectedColors, new_.colors, problems)

  // radii
  const expectedRadii = old_.radii.map(r => canonicalRadius(r))
  checkAxis('radius', expectedRadii, new_.radii, problems)

  // fontSizes
  const expectedFontSizes = old_.fontSizes.map(f => canonicalFontSize(f))
  checkAxis('fontSize', expectedFontSizes, new_.fontSizes, problems)

  // fontWeights — identity (no collapse)
  checkAxis('fontWeight', old_.fontWeights, new_.fontWeights, problems)

  return { ok: problems.length === 0, problems }
}

/** Compare two arrays as multisets; push problem strings on mismatch. */
function checkAxis<T extends string | number>(
  axis: string,
  expected: T[],
  actual: T[],
  problems: string[],
): void {
  const expCounts = toCounts(expected)
  const actCounts = toCounts(actual)

  const missing: T[] = []
  const extra: T[] = []

  // values in expected but not (enough) in actual
  for (const [val, count] of expCounts.entries()) {
    const have = actCounts.get(val) ?? 0
    if (have < count) {
      for (let i = 0; i < count - have; i++) missing.push(val)
    }
  }
  // values in actual but not (enough) in expected
  for (const [val, count] of actCounts.entries()) {
    const have = expCounts.get(val) ?? 0
    if (have < count) {
      for (let i = 0; i < count - have; i++) extra.push(val)
    }
  }

  if (missing.length > 0 || extra.length > 0) {
    if (missing.length > 0) {
      problems.push(`${axis}: expected ${missing.join(', ')} but not found in new`)
    }
    if (extra.length > 0) {
      problems.push(`${axis}: unexpected value(s) in new: ${extra.join(', ')}`)
    }
  }
}

function toCounts<T extends string | number>(arr: T[]): Map<T, number> {
  const map = new Map<T, number>()
  for (const v of arr) map.set(v, (map.get(v) ?? 0) + 1)
  return map
}
