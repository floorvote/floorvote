import { color, fontSize, fontWeight } from './tokens'

// Single source of truth for comment author-line + body styling, shared so the
// web comment list (web/src/pages/BillDetail.tsx) and the @-mention email
// comment row (api/src/lib/emailBillCard.ts → renderCommentRow) can't drift.
// Values mirror the long-standing BillDetail comment styling: the author name,
// subtitle, and timestamp are all the small meta size; the body is one tier up.
//
// Style only — the timestamp *string* differs by surface (relative on web,
// absolute in email, since email has no "now"); both render it at dateSize.
export const COMMENT_STYLE = {
  // Author name
  nameSize: fontSize.sm,
  nameWeight: fontWeight.semibold,
  nameColor: color.textPrimary,
  // Subtitle, riding alongside the name
  subtitleSize: fontSize.sm,
  subtitleWeight: fontWeight.normal,
  subtitleColor: color.textMuted,
  // Timestamp
  dateSize: fontSize.sm,
  dateColor: color.textMuted,
  // Comment body
  bodySize: fontSize.base,
  bodyColor: color.textSlate,
  bodyLineHeight: 1.5,
} as const
