import type React from 'react'
import { color, fontSize, fontWeight } from '../styles/tokens'

export const SECTION_LABEL: React.CSSProperties = {
  fontSize: fontSize.sm,
  fontWeight: fontWeight.semibold,
  color: color.textMuted,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
}

export const CHROME_TEXT: React.CSSProperties = {
  fontSize: fontSize.xs,
  color: color.textMuted,
}

// Title for a settings/account card section (e.g. "Profile", "Invite a new member").
// marginTop is pinned to 0 (not just marginBottom) because several call sites now
// render this on <h1>/<h2> elements (Task 17) rather than <div>s — without it, the
// UA stylesheet's default heading margin-block would add unwanted top spacing that
// a plain <div> never had.
export const CARD_TITLE: React.CSSProperties = {
  fontSize: fontSize.lg,
  fontWeight: fontWeight.bold,
  color: color.textPrimary,
  marginTop: 0,
  marginBottom: 6,
}

// Label sitting above a form input (e.g. "Name", "Email(s)").
export const FORM_LABEL: React.CSSProperties = {
  fontSize: fontSize.sm,
  fontWeight: fontWeight.semibold,
  color: color.textSlate,
  display: 'block',
  marginBottom: 4,
}

// Helper/hint text shown below an input or title.
export const HELPER_TEXT: React.CSSProperties = {
  fontSize: fontSize.sm,
  color: color.textMuted,
}

// Visually hides an element while keeping it in the accessibility tree — e.g. a
// polite aria-live status region, or a <label> for a visually-labeled input.
// Shared so call sites don't each hand-roll the clip-rect incantation.
export const SR_ONLY: React.CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: 'hidden',
  clip: 'rect(0, 0, 0, 0)',
  whiteSpace: 'nowrap',
  border: 0,
}
