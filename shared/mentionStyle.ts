import { color, fontWeight } from './tokens'

// Single source of truth for @-mention pill colors, shared by every surface that
// renders a mention so the web UI and the emails can't drift apart:
//   web   — ROLE_CHIP (web/src/lib/chipStyles.ts) and the mention <style> blocks
//           in CommentContent.tsx, RichTextEditor.tsx, NotificationsSlideOver.tsx
//   email — api/src/lib/mentions.ts (inline comment mentions + the role footer)
//
// Guard: api/test/lib/mentionEmail.test.ts asserts the rendered email uses these
// exact values, so hardcoding a colour in the email (the old drift) fails CI.
//
// role/@everyone = the indigo "people/team" identity; user = a neutral gray pill
// that stays legible on white (the old near-white fill was too faint) and reads
// distinctly from both roles (indigo) and topic tags (blue).
export const MENTION_STYLE = {
  role: { bg: color.roleMentionBg, text: color.roleMentionText },
  user: { bg: color.borderDefault, text: color.textSlate500 },
  // One weight for every mention pill on every surface. Colours were already
  // shared here; weight was not, and drifted — the mentions panel's attribution
  // chip was semibold (600) while the pill inside the quoted comment, ROLE_CHIP,
  // and the emails were all medium (500). A role mention prints the pill twice
  // in one panel row (attribution line + the comment that contains it), so the
  // mismatch was plainly visible. Read this instead of writing a literal.
  weight: fontWeight.medium,
} as const
