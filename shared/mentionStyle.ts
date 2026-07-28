import { color } from './tokens'

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
} as const
