import type React from 'react'
import { color, radius, fontSize, fontWeight, shadow } from '../styles/tokens'
export { PRIORITY_COLORS, POSITION_COLORS } from '../../../shared/billChipColors'
import { CHIP_MINI_DIMS } from '../../../shared/billChipColors'

// Canonical chip styles — all chip-like components import from here.
// One change here propagates everywhere.

export const CHIP_BASE = {
  display: 'inline-flex' as const,
  alignItems: 'center' as const,
  fontSize: fontSize.sm,
  fontWeight: fontWeight.semibold,
  padding: '3px 10px',
  borderRadius: radius.sm,
  // Quieter: no resting border. chipOutline() supplies the ring on hover/selected.
  // Fill bumped from surfaceSubtle → countChipBg so the chip keeps a shape without a border.
  border: '1px solid transparent',
  background: color.countChipBg,
  color: color.textSecondary,
}

// Mini variant — same proportions, smaller scale (used in sidebar bill rows, tooltips)
export const CHIP_MINI = {
  ...CHIP_BASE,
  fontSize: CHIP_MINI_DIMS.fontSize,
  padding: CHIP_MINI_DIMS.padding,
  borderRadius: CHIP_MINI_DIMS.radius,
}

// Dark navy bill number badge
export const BILL_BADGE_BASE = {
  display: 'inline-flex' as const,
  alignItems: 'center' as const,
  background: color.billBadgeNavy,
  color: color.white,
  fontWeight: fontWeight.bold,
  fontSize: fontSize.sm,
  padding: '3px 10px',
  borderRadius: radius.sm,
  letterSpacing: '0.02em',
  border: '1px solid transparent',
}

export const BILL_BADGE_MINI = {
  ...BILL_BADGE_BASE,
  fontSize: CHIP_MINI_DIMS.fontSize,
  padding: CHIP_MINI_DIMS.padding,
  borderRadius: CHIP_MINI_DIMS.radius,
  border: '1px solid transparent', // keeps height equal to bordered chips
  flexShrink: 0 as const,
}

export function chipOutline(isActive: boolean, hovered: boolean, clickable: boolean) {
  return {
    outline: isActive ? `2px solid ${color.accentBlue}` : (hovered && clickable) ? `2px solid ${color.accentBlueMuted}` : 'none',
    outlineOffset: 2,
  }
}

export const POSITION_FALLBACK = { bg: color.surfaceMuted, color: color.textSlate500, border: color.borderDefault }

// Gray pill for inline counts (comment count, vote total, member count, etc.).
// Fill/text are a dedicated pairing (not the shared muted tokens): countChipBg
// is the midpoint between surfaceMuted and borderDefault, so the pill reads as a
// distinct shape rather than near-flat; countChipText is tuned to sit right on
// the 4.5:1 AA floor against that fill.
export const COUNT_BADGE = {
  fontSize: fontSize.xs,
  color: color.countChipText,
  background: color.countChipBg,
  padding: '1px 6px',
  borderRadius: radius.lg,
  fontWeight: fontWeight.normal,
}

// COUNT_BADGE with an active/hover state. When `active`, the gray fill drops to
// `activeBg` — `transparent` (default) so the chip melts into a highlighted
// parent (e.g. an orange nav row or widget header), or an explicit fill when the
// chip itself is the hover target. The text colour never changes, matching the
// Bills/Calendar nav count badges.
export function countBadge(active = false, activeBg = 'transparent'): React.CSSProperties {
  return {
    ...COUNT_BADGE,
    background: active ? activeBg : COUNT_BADGE.background,
  }
}

// Light-blue pill for team role labels — used everywhere a role name is shown.
// The X button style is separate and only used in admin contexts.
export const ROLE_CHIP: React.CSSProperties = {
  fontSize: fontSize.xs,
  fontWeight: fontWeight.medium,
  // "Light" separation from topic tags: a step up the blue ramp + the pill shape,
  // so a role/user chip never reads as a bill tag (which stays a pale rectangle).
  color: color.tagTextBlue,
  background: color.bgRoleChip,
  borderRadius: radius.pill,
  padding: '3px 9px',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  whiteSpace: 'nowrap',
}

export const ROLE_CHIP_X: React.CSSProperties = {
  color: color.roleChipXBlue,
  cursor: 'pointer',
  fontSize: fontSize.sm,
  lineHeight: '1',
  marginLeft: 1,
}

// Purple pill for admin/owner-only indicators
export const ADMIN_BADGE = {
  fontSize: fontSize.xs,
  fontWeight: fontWeight.semibold,
  color: color.brandViolet,
  background: color.bgVioletChip,
  borderRadius: radius.pill,
  padding: '3px 9px',
  display: 'inline-block' as const,
  flexShrink: 0 as const,
  whiteSpace: 'nowrap' as const,
}

// Display name with email fallback — use everywhere a user name is shown.
export function displayName(user: { name?: string | null; email?: string | null }): string {
  return user.name || user.email || ''
}

// Shared chrome (background, border, shadow, radius) for every white tooltip —
// the single-line text bubble below, plus the rich stragglers BillHoverTooltip
// and ChangeHistoryTooltip, which spread this and keep their own layout.
export const TOOLTIP_CHROME = {
  background: color.white,
  border: `1px solid ${color.borderDefault}`,
  boxShadow: shadow.md,
  borderRadius: radius.sm,
} as const

// Shared style for single-line hover tooltips — apply position: fixed and
// left/top separately.
export const TOOLTIP_STYLE = {
  ...TOOLTIP_CHROME,
  color: color.textSlate500,
  padding: '5px 10px',
  fontSize: fontSize.sm,
  whiteSpace: 'nowrap' as const,
  zIndex: 9000,
  pointerEvents: 'none' as const,
}

// Canonical tooltip positioning — centers the tooltip above the anchor element.
// Pass the { x, y } from getBoundingClientRect() where x = r.left + r.width / 2, y = r.top.
export function tooltipPosition(pos: { x: number; y: number }) {
  return {
    position: 'fixed' as const,
    left: pos.x,
    top: pos.y,
    transform: 'translateX(-50%) translateY(calc(-100% - 6px))',
  }
}

// Sort roles alphabetically by name. Use everywhere role chips are rendered.
export function sortRoles<T extends { name: string }>(roles: T[]): T[] {
  return [...roles].sort((a, b) => a.name.localeCompare(b.name))
}

// Structural subset of DOMRect, so this helper carries no DOM-lib dependency.
// (api/ reuses chipStyles in its digest-email builder and typechecks it under a
// Workers tsconfig that has no DOM lib; a real DOMRect still satisfies this.)
type RectLike = { left: number; right: number; top: number; bottom: number; width: number; height: number }

// Tooltip positioned below the anchor element, clamped to container bounds.
// anchorRect: getBoundingClientRect() of the anchor. containerRect: getBoundingClientRect() of the bounding container.
export function tooltipPositionBelow(anchorRect: RectLike, containerRect?: RectLike) {
  const left = containerRect
    ? Math.max(containerRect.left, Math.min(anchorRect.left, containerRect.right))
    : anchorRect.left
  return {
    position: 'fixed' as const,
    left,
    top: anchorRect.bottom + 6,
    maxWidth: containerRect ? containerRect.right - left : undefined,
  }
}

// Tooltip positioned to the right of the anchor element, vertically centered.
export function tooltipPositionRight(anchorRect: RectLike) {
  return {
    position: 'fixed' as const,
    left: anchorRect.right + 8,
    top: anchorRect.top + anchorRect.height / 2,
    transform: 'translateY(-50%)',
  }
}
