import { color, radius, fontSize, fontWeight } from '../styles/tokens'

/**
 * The amber new-match state with nothing to do: what a member sees where an
 * admin has the priority dropdown reading "New · Set priority". It takes the
 * dropdown's amber fill, text, and border, but is a plain label (no chevron,
 * not focusable), because a member can't set a priority or dismiss.
 */
export function NewMatchChip() {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center',
      fontSize: fontSize.sm, fontWeight: fontWeight.semibold,
      padding: '3px 10px', borderRadius: radius.sm,
      border: `1px solid ${color.borderAmber}`,
      background: color.bgAmberPriority, color: color.textAmberDark,
      whiteSpace: 'nowrap',
    }}>
      New match
    </span>
  )
}
