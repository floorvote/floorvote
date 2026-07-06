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
  Support:       { bg: color.bgSuccessChip,   color: color.textVoteSupport,  border: color.borderGreenStrong },
  Oppose:        { bg: color.bgRedPriority,   color: color.textDanger,       border: color.bgRedDisabled },
  Neutral:       { bg: color.surfaceMuted,    color: color.textSlate500,     border: color.borderDefault },
  Amend:         { bg: color.bgAmberPriority, color: color.textAmberDark,    border: color.borderAmber },
  Monitor:       { bg: color.bgVioletChip,    color: color.textVioletAdmin,  border: color.borderVioletSoft },
  'No Position': { bg: color.surfaceMuted,    color: color.textSlate500,     border: color.borderDefault },
}
