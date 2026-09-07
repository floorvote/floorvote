import { HoverTooltip } from '../../components/HoverTooltip'
import { color, radius, fontSize, fontWeight } from '../../styles/tokens'

// Renders the operator that already existed implicitly between chip groups.
//
// HoverTooltip is used here WITHOUT its `toggletip` prop, so it takes the
// plain-wrapper branch (HoverTooltip.tsx's final `else`), not the toggletip
// branch's own `<button>` — nesting this button inside that one would be
// invalid HTML, so toggletip mode is not an option here. In the plain-wrapper
// branch the bubble is rendered `aria-hidden` and gets neither a
// `role="tooltip"` nor an `aria-describedby` link (those are wired only on
// the toggletip branch, a path this component never takes). It is also
// mouse-only: HoverTooltip's handlePointerEnter ignores non-mouse pointer
// types, so a touch tap reveals nothing. In short, the bubble is a sighted
// mouse/keyboard-only visual affordance and reaches neither a touch user nor
// a screen-reader user. The `aria-label` below is what actually carries the
// state-and-effect semantics to assistive tech; the tooltip is a visual
// enhancement layered on top of it, not the accessibility mechanism.
export function GroupOperator({ matchAny, onToggle }: { matchAny: boolean; onToggle: () => void }) {
  const tooltipText = matchAny
    ? 'Bills must match any of these groups. Click to require all of them instead. Search, My bills, New matches, and Not yet voted always narrow.'
    : 'Bills must match all of these groups. Click to match any of them instead. Search, My bills, New matches, and Not yet voted always narrow.'
  const ariaLabel = matchAny
    ? 'Currently matching any of these filter groups (OR). Activate to switch to matching all of them (AND) instead. This does not affect search, my bills, new matches, or not yet voted, which always narrow the results.'
    : 'Currently matching all of these filter groups (AND). Activate to switch to matching any of them (OR) instead. This does not affect search, my bills, new matches, or not yet voted, which always narrow the results.'
  return (
    <HoverTooltip maxWidth={300} text={tooltipText}>
      <button
        type="button"
        onClick={onToggle}
        aria-label={ariaLabel}
        aria-pressed={matchAny}
        style={{
          fontSize: fontSize.xs, fontWeight: fontWeight.semibold, letterSpacing: '0.05em',
          padding: '1px 6px', margin: '0 2px', cursor: 'pointer',
          borderRadius: radius.sm, border: `1px dashed ${color.borderDefault}`,
          background: color.white, color: color.textMuted,
        }}
      >
        {matchAny ? 'OR' : 'AND'}
      </button>
    </HoverTooltip>
  )
}
