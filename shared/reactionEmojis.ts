// Single source of truth for the reaction emoji the product offers.
//
// The picker (web/src/components/ReactionPicker.tsx) renders exactly this list,
// and POST /comments/:id/reactions accepts exactly this list — membership here
// is the entire validation rule, so the API can never accept an emoji a member
// cannot click, nor refuse one they can. Adding an emoji is one edit.
//
// Because the set is closed and every member is a short literal, the handler
// needs no length cap and no Unicode property test: there is nothing to smuggle
// through an exact-match check. The demo seeds draw from this list too, so
// seeded chips stay joinable without any exception in the validator.
export const REACTION_EMOJIS = ['❤️', '👍', '👎', '😂', '😭', '💯', '🔥', '🤔'] as const

export type ReactionEmoji = (typeof REACTION_EMOJIS)[number]

/** True if `emoji` is one of the eight the product offers. */
export function isReactionEmoji(emoji: string): emoji is ReactionEmoji {
  return (REACTION_EMOJIS as readonly string[]).includes(emoji)
}
