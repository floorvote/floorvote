import { color, radius, fontSize } from '../styles/tokens'

// Shared tag chip style — bills list rows and bill detail AI summary box
export const TAG_CHIP = {
  fontSize: fontSize.xs,
  background: color.bgInfo,
  color: color.tagTextBlue,
  padding: '1px 6px',
  borderRadius: radius.sm,
  border: `1px solid ${color.tagBorderBlue}`,
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
