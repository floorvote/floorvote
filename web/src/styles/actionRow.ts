import type React from 'react'
import { color, radius, fontSize, fontWeight } from './tokens'

// Shared "action row" styles — the flex row that holds a save/action button
// plus adjacent hint/result text, used across Config, Account, and Draft-bills pages.
export const actionRowStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 12,
  marginTop: 20, paddingTop: 16, borderTop: `1px solid ${color.borderDefault}`,
}

// Same as actionRowStyle but without the top rule — for the first row of a
// stacked group directly under a section header, where the rule would be redundant.
export const actionRowStyleFirst: React.CSSProperties = {
  display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 12, marginTop: 20,
}

export const actionBtnBlue = (disabled: boolean): React.CSSProperties => ({
  background: disabled ? color.accentBlueMuted : color.accentBlue, color: color.white, border: 'none', borderRadius: radius.md,
  padding: '8px 14px', cursor: disabled ? 'not-allowed' : 'pointer', fontSize: fontSize.sm, fontWeight: fontWeight.medium,
  width: 224, flexShrink: 0, whiteSpace: 'normal', textAlign: 'center', lineHeight: 1.4,
})

export const actionBtnRed = (disabled: boolean): React.CSSProperties => ({
  background: disabled ? color.bgRedDisabled : color.textErrorRed, color: color.white, border: 'none', borderRadius: radius.md,
  padding: '8px 14px', cursor: disabled ? 'not-allowed' : 'pointer', fontSize: fontSize.sm, fontWeight: fontWeight.medium,
  width: 224, flexShrink: 0, whiteSpace: 'normal', textAlign: 'center', lineHeight: 1.4,
})
