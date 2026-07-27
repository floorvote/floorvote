import { color, radius, fontSize, fontWeight } from '../styles/tokens'

// Shared tag chip style — bills list rows and bill detail AI summary box.
// The H214 blue fill (bgBlueChip) keeps the tag legible on the AI-summary's
// surfaceSubtle box, where the older near-white fill melted in. Medium weight
// puts it in the "metadata pill" tier, a step below the semibold signal chips.
export const TAG_CHIP = {
  fontSize: fontSize.xs,
  fontWeight: fontWeight.medium,
  background: color.bgBlueChip,
  color: color.tagTextBlue,
  padding: '1px 6px',
  borderRadius: radius.sm,
  // Quieter: no resting border. TAG_CHIP_HOVERED / TAG_CHIP_ACTIVE add the ring on interaction.
  border: '1px solid transparent',
  cursor: 'pointer',
} as const

export const TAG_CHIP_HOVERED = {
  ...TAG_CHIP,
  outline: `2px solid ${color.accentBlueMuted}`,
  outlineOffset: 2,
} as const

export const TAG_CHIP_ACTIVE = {
  ...TAG_CHIP,
  outline: `2px solid ${color.accentBlue}`,
  outlineOffset: 2,
} as const
