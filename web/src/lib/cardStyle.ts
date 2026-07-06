import { color, radius, shadow } from '../styles/tokens'

// Shared card style — consistent white panels with subtle shadow across pages
export const CARD = {
  background: color.white,
  border: `1px solid ${color.borderDefault}`,
  borderRadius: radius.lg,
  boxShadow: shadow.sm,
} as const
