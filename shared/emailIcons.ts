// Single source of truth for the email icon set.
//
// Emails can't load the Material Symbols font, so every glyph the emails show is
// pre-rendered to a transparent-background PNG (one per glyph+color+fill, since
// email CSS can't recolor an image) under web/public/email-icons/, referenced as
// `${APP_URL}/email-icons/<file>`.
//
// The needs are DERIVED from the same shared tables the Feed and calendar
// render from (CHANGE_ICONS / USER_EVENT_ICONS / EVENT_SOURCE_DESCRIPTORS +
// position colors), so the email can't drift from the website. The generator
// (scripts/gen-email-icons.ts) and the drift test both read this list.

import { color } from './tokens'
import { POSITION_FEED_ICON } from './billChipColors'
import { CHANGE_ICONS, USER_EVENT_ICONS } from './billCardModel'
import { EVENT_SOURCE_DESCRIPTORS } from './eventLineModel'

export interface EmailIconNeed {
  icon: string   // Material Symbols glyph — must be in the web/index.html allowlist
  hex: string    // fill color baked into the PNG
  fill: boolean  // true → filled variant (Material Symbols `-fill` svg)
}

/** Filename for an email icon, e.g. `gavel__1e3a5f.png` / `thumbs_up_down__1d9e75-fill.png`.
 *  Deterministic from (glyph, color, fill) so any consumer with a resolved row
 *  color can compute the src with no lookup table. */
export function emailIconSrc(icon: string, hex: string, fill = false): string {
  return `${icon}__${hex.replace('#', '').toLowerCase()}${fill ? '-fill' : ''}.png`
}

function dedupe(needs: EmailIconNeed[]): EmailIconNeed[] {
  const seen = new Set<string>()
  return needs.filter(n => {
    const k = emailIconSrc(n.icon, n.hex, n.fill)
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

// Build the full set the emails reference, mirroring shared/billCardModel's row
// coloring exactly:
//  - calendar source markers (week-ahead email)
//  - bill_updated change rows — all in textSecondary, outline
//  - hearing rows — gavel in the amber hearing color
//  - user-event rows — each USER_EVENT_ICONS entry in its color/fill, except
//    priority_set (rendered as the priority square, not an icon); position_set
//    is emitted once per position color (the model overrides its color per
//    position).
export const EMAIL_ICON_NEEDS: EmailIconNeed[] = dedupe([
  ...EVENT_SOURCE_DESCRIPTORS.map(d => ({ icon: d.icon, hex: d.color, fill: false })),
  ...Object.values(CHANGE_ICONS).map(icon => ({ icon, hex: color.textSecondary, fill: false })),
  // buildBillCardModel's two fallback glyphs — `change_history` for an unknown
  // changeType (textSecondary, like other change rows) and `circle` for an
  // unknown event type (textMuted). Generated so the no-drift guarantee holds
  // even if a new type lands upstream without a CHANGE_ICONS/USER_EVENT_ICONS entry.
  { icon: 'change_history', hex: color.textSecondary, fill: false },
  { icon: 'circle', hex: color.textMuted, fill: false },
  { icon: 'gavel', hex: color.textAmberHearing, fill: false },
  ...Object.entries(USER_EVENT_ICONS)
    .filter(([type]) => type !== 'priority_set')
    .flatMap(([type, cfg]) => {
      const fill = (cfg.fill ?? 0) === 1
      if (type === 'position_set') {
        return Object.values(POSITION_FEED_ICON).map(hex => ({ icon: cfg.name, hex, fill }))
      }
      return [{ icon: cfg.name, hex: cfg.color, fill }]
    }),
  // Calendar event meta-line icons (week-ahead email), muted to match the web
  // agenda card's meta color (color.textMuted).
  { icon: 'schedule', hex: color.textMuted, fill: false },
  { icon: 'location_on', hex: color.textMuted, fill: false },
  { icon: 'link_2', hex: color.textMuted, fill: false },
])

/** Parse the `icon_names=` allowlist out of web/index.html. */
export function parseIconAllowlist(indexHtml: string): string[] {
  const m = indexHtml.match(/icon_names=([^"&]+)/)
  if (!m) return []
  return m[1].split(',').map(s => s.trim()).filter(Boolean)
}

/** Generated PNG directory, relative to the repo root. */
export const EMAIL_ICONS_DIR = 'web/public/email-icons'
