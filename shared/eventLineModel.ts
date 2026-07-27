import { color, fontSize, fontWeight, radius } from './tokens'
import { formatHearingTimeShort } from './hearingTime'
import { CARD_STYLE } from './billCardModel'

export interface EventEdgeSource { source: string }

export interface EventForBodyModel {
  description?: string | null
  location?: string | null
  bills: Array<{ billTitle?: string | null }>
  time?: string | null
  status?: string | null
}

export interface EventBodyModel {
  time: string | null
  text: string
  location: string | null
  cancelled: boolean
}

// Shared event text styles — compatible with React CSSProperties in consumers.
// Not typed as CSSProperties here to avoid a React dependency in shared/.
export const EVENT_TITLE_STYLE = {
  fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: color.textPrimary,
} as const

export const EVENT_META_STYLE = {
  fontSize: fontSize.xs, color: color.textMuted,
} as const

// Static base for an event card — consumers spread this and add the dynamic
// padding, opacity, and boxShadow.
export const EVENT_CARD_BASE = {
  display: 'flex' as const,
  alignItems: 'flex-start' as const,
  gap: 8,
  background: color.white,
  border: `1px solid ${color.borderDefault}`,
  borderRadius: radius.lg,
  boxShadow: CARD_STYLE.shadow,
  marginBottom: 8,
} as const

export interface EventSourceDescriptor {
  icon: 'gavel' | 'calendar_today'
  color: string  // icon fill: navy (hearing) | blue (custom)
  tint: string   // tile background behind the icon
  /** Human label — used by the web aria-label/hover tip AND the email title
   *  tooltip, so the wording can't drift across surfaces. */
  label: string
}

// Source marker for an event: gavel for data-pulled hearings, calendar_today
// for custom/editable events. Replaces the old navy/blue left-edge color.
export function eventSourceIcon(event: EventEdgeSource): EventSourceDescriptor {
  return event.source === 'custom'
    ? { icon: 'calendar_today', color: color.accentBlue,    tint: color.bgInfo, label: 'Custom event' }
    : { icon: 'gavel',          color: color.billBadgeNavy, tint: color.bgInfo, label: 'Hearing' }
}

// The tinted source-icon tile dimensions, shared by the web EventSourceIcon and
// the week-ahead email so the marker is the same size on both. (The web glyph is
// a font at fontSize.base; the email glyph is a `glyphPx`-sized PNG.)
export const EVENT_SOURCE_TILE = { size: 22, radius: radius.md, glyphPx: 14 } as const

// Every source-marker descriptor — the email-icon generator enumerates these to
// learn which (glyph, color) PNGs to render. Add a source above and it flows
// through here automatically. (The email PNG filename is computed from the
// descriptor's icon+color by shared/emailIcons.ts — see emailIconSrc.)
export const EVENT_SOURCE_DESCRIPTORS: EventSourceDescriptor[] = [
  eventSourceIcon({ source: 'hearing' }),
  eventSourceIcon({ source: 'custom' }),
]

/** Display label for an event URL: drop the scheme and a leading `www.`,
 *  plus any trailing slash, keeping the host + path. The anchor still links to
 *  the original, unmodified URL — only the visible label is shortened. */
export function formatEventUrl(url: string): string {
  return url.trim().replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/+$/, '')
}

// Resolve the line-1 text and whether location gets its own line.
export function eventBodyModel(event: EventForBodyModel, compact: boolean): EventBodyModel {
  const desc = event.description?.trim() || ''
  const loc = event.location?.trim() || ''
  const billTitle = event.bills[0]?.billTitle?.trim() || ''
  return {
    time: formatHearingTimeShort(event.time ?? null),
    // Title: the compact month cell keeps the old description→location→bill
    // fallback so a bare event still shows something inline. The full variant
    // drops the location rung (location now has its own line) and falls back
    // to "Hearing".
    text: compact ? (desc || loc || billTitle) : (desc || billTitle || 'Hearing'),
    // Location line: never in the compact cell; always (when present) in the
    // full variant, independent of the title text.
    location: compact ? null : (loc || null),
    cancelled: event.status === 'cancelled',
  }
}
