import { color, fontSize, radius, fontWeight } from '../styles/tokens'

/**
 * A party chip: the sponsor list's default size, or `mini` for tight lists such as a roll call's voters.
 * The party code is the chip's text, so the party never rides on color alone.
 */
export function PartyBadge({ party, size = 'default' }: { party: string; size?: 'default' | 'mini' }) {
  const bg = party === 'D' ? color.bgBlueChip : party === 'R' ? color.bgRedPriority : color.surfaceMuted
  const partyColor = party === 'D' ? color.linkBlue : party === 'R' ? color.textDanger : color.textSlate500
  const mini = size === 'mini'
  // display:inline-block prevents text-decoration from the parent <a> punching through the chip background
  return (
    <span style={{
      marginLeft: mini ? 4 : 3,
      // 9px is below the smallest token (xs, 10): the mini chip is deliberately smaller than the sponsor chip.
      fontSize: mini ? 9 : fontSize.xs,
      padding: mini ? '0 3px' : '1px 4px',
      borderRadius: radius.sm, background: bg, color: partyColor, fontWeight: fontWeight.bold,
      display: 'inline-block', textDecoration: 'none',
    }}>{party}</span>
  )
}
