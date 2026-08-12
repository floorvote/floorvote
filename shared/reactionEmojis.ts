// Single source of truth for the reaction emoji the UI offers.
//
// The picker (web/src/components/ReactionPicker.tsx) renders exactly this list,
// and the POST /comments/:id/reactions handler accepts exactly this list for a
// NEW emoji on a comment. Both sides importing the same array is the point: a
// picker change is one edit, and validation can never be looser or tighter than
// what a member can actually click.
//
// Not the whole rule, though — an emoji ALREADY on a comment stays acceptable
// so that clicking an existing chip to join it keeps working. The demo seeds use
// ✅ 👀 🎉 😕, four emoji this list deliberately does not carry; a picker-only
// rule would make most seeded chips unjoinable. See the handler for the ordering
// (byte cap and character class run first, on every path).
export const REACTION_EMOJIS = ['❤️', '👍', '👎', '😂', '😭', '💯', '🔥', '🤔'] as const

export type ReactionEmoji = (typeof REACTION_EMOJIS)[number]

/** True if `emoji` is one of the eight the picker offers. */
export function isPickerEmoji(emoji: string): boolean {
  return (REACTION_EMOJIS as readonly string[]).includes(emoji)
}
