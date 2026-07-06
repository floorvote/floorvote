import type { CSSProperties } from 'react'
import { color, radius } from '../styles/tokens'

/** Outlined, hoverable click-to-edit container — matches the personal-note field. */
export function editableFieldBox(isHovered: boolean): CSSProperties {
  return {
    cursor: 'text',
    border: `1px solid ${isHovered ? color.borderStrong : color.borderDefault}`,
    borderRadius: radius.md,
    background: isHovered ? color.surfaceMuted : color.white,
    transition: 'border-color 0.15s, background 0.15s',
  }
}
