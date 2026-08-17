import { color, radius, fontSize } from './tokens'

// Geometry of the mini chip/badge (sidebar bill rows, tooltips, and the email
// bill chip), shared so the size stays in lockstep across web and email. Colors
// and font-weight stay with each variant; this is only the dimensions.
export const CHIP_MINI_DIMS = { padding: '2px 6px', radius: radius.sm, fontSize: fontSize.xs } as const

export const PRIORITY_COLORS: Record<string, { fill: string; text: string; dot: string; label: string }> = {
  high:   { fill: color.priorityHigh,   text: color.white, dot: color.priorityHigh,   label: 'High priority' },
  medium: { fill: color.priorityMedium, text: color.white, dot: color.priorityMedium, label: 'Medium priority' },
  low:    { fill: color.priorityLow,    text: color.white, dot: color.priorityLow,    label: 'Low priority' },
}

export const POSITION_COLORS: Record<string, { bg: string; color: string; border: string }> = {
  Support:       { bg: color.bgSuccessChip,   color: color.textSuccessDark,  border: color.borderGreenStrong },
  Oppose:        { bg: color.bgRedPriority,   color: color.textDanger,       border: color.bgRedDisabled },
  Neutral:       { bg: color.countChipBg,     color: color.textSlate500,     border: color.borderDefault },
  // Amend deepened (borderAmber fill + textAmberWarning) so it no longer reads as the
  // relevance-score amber (#fef3c7 / textAmberDark) — ΔE ~25 apart, no new hue.
  // Its border was the same token as its fill, so Amend was the only position
  // chip drawn with no outline at all — visible wherever c.border is actually
  // painted, i.e. the CompactPositionSelect dropdown. accentAmber restores the
  // outline at the weight its siblings carry: Support, Oppose, and Monitor are
  // each a -100 fill against a -300 border, and since this fill is already
  // amber-200, ~amber-400 is the token two steps up. accentAmber is the only
  // existing amber in that range; the darker text ambers sit 5-6 steps past the
  // fill and would make Amend the heaviest chip in the row.
  Amend:         { bg: color.borderAmber,     color: color.textAmberWarning, border: color.accentAmber },
  Monitor:       { bg: color.bgVioletChip,    color: color.brandViolet,  border: color.borderVioletSoft },
  'No Position': { bg: color.countChipBg,     color: color.textSlate500,     border: color.borderDefault },
}

// Feed-row position icon tints (also mirrored into the digest emails). One step
// brighter than each POSITION_COLORS[*].color — those are tuned dark for AA text
// on their chip fills, which reads as near-black at icon size on the white feed
// row. These are icon-glyph colors, not text-on-fill, so they don't carry the
// same contrast requirement. buildBillCardModel (feed) and emailIcons (digest
// PNGs) both read this, so the two can't drift.
export const POSITION_FEED_ICON: Record<string, string> = {
  Support:       color.textSuccess,      // #16a34a
  Oppose:        color.textErrorRed,     // #dc2626
  Monitor:       color.brandViolet,      // #7c3aed
  Amend:         color.textAmberHearing, // #b45309
  Neutral:       color.textSlate500,     // #475569
  'No Position': color.textSlate500,
}
