import { color, radius, fontSize, fontWeight } from '../styles/tokens'

// Shared styles for a boxed setting: a bordered box holding a title, a
// description, and a toggle on the right of the header. The admin Notifications
// page and the AI settings on the Config page use them, so boxed toggles look
// alike. Keep the key order: tests compare the rendered style attribute.

export const SETTING_BOX = {
  padding: '12px 14px',
  border: `1px solid ${color.borderDefault}`,
  borderRadius: radius.lg,
  background: color.white,
} as const

export const SETTING_BOX_HEADER = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 16,
} as const

export const SETTING_BOX_TITLE = { fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: color.textPrimary } as const

export const SETTING_BOX_DESC = { fontSize: fontSize.sm, color: color.textSlate, lineHeight: 1.5, marginTop: 2 } as const

/** The box itself, dimmed to show that a locked demo can't change it. */
export function settingBox(locked: boolean): React.CSSProperties {
  return { ...SETTING_BOX, opacity: locked ? 0.55 : 1 }
}
