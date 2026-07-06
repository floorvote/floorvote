import type React from 'react'
import { color, radius, fontWeight } from '../styles/tokens'

export type VoteKey = 'support' | 'neutral' | 'oppose'

// Three-state colour scheme per vote position: resting (faint always-on tint),
// hover (tint deepens), cast (solid fill + white text). Shared by every place
// member-vote buttons render (bill detail, sidebar, bill list) so they can't drift.
const VOTE_SCHEMES: Record<VoteKey, {
  restBg: string; restBorder: string; hoverBg: string; hoverBorder: string
  text: string; castBg: string; castHoverBg: string
}> = {
  support: { restBg: color.bgSuccessFaint, restBorder: color.borderGreenFaint,   hoverBg: color.bgSuccess,    hoverBorder: color.borderGreenChip, text: color.textVoteSupport, castBg: color.voteSupport,   castHoverBg: color.textSuccess },
  neutral: { restBg: color.surfaceSubtle,  restBorder: color.borderNeutralFaint, hoverBg: color.surfaceMuted, hoverBorder: color.borderDefault,   text: color.textSecondary,   castBg: color.textMuted,     castHoverBg: color.textSecondary },
  oppose:  { restBg: color.bgDangerFaint,  restBorder: color.borderRedFaint,     hoverBg: color.bgDangerSoft, hoverBorder: color.borderRedChip,   text: color.textDanger,      castBg: color.textDeleteRed, castHoverBg: color.textErrorRed },
}

// State-dependent styles for a member-vote pill button. Spread into the button's
// style alongside per-call sizing (width / fontSize / padding). Font weight is
// constant across states — the pill never changes weight when cast/uncast.
export function voteButtonStyle(voteKey: VoteKey, isActive: boolean, hovered: boolean): React.CSSProperties {
  const s = VOTE_SCHEMES[voteKey]
  const bg = isActive ? (hovered ? s.castHoverBg : s.castBg) : (hovered ? s.hoverBg : s.restBg)
  return {
    background: bg,
    border: `1.5px solid ${isActive ? bg : hovered ? s.hoverBorder : s.restBorder}`,
    borderRadius: radius.pill,
    color: isActive ? color.white : s.text,
    fontWeight: fontWeight.semibold,
    cursor: 'pointer',
    textAlign: 'center',
    transition: 'background 0.12s, border-color 0.12s, color 0.12s',
  }
}
