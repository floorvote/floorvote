import { COUNT_BADGE } from '../../lib/chipStyles'
import { color, radius, fontSize, fontWeight } from '../../styles/tokens'

export interface FilterToggleProps {
  label: string
  active: boolean
  onToggle: () => void
  /** Count badge, omitted when the caller has no count to show. */
  count?: number
  /** Appends ' ✓' when active — the binary custom-field treatment. */
  showCheck?: boolean
}

/**
 * A single on/off filter pill: the shared active-treatment chrome behind My
 * bills, New matches, Not yet voted, and every binary custom field toggle.
 *
 * Named for what it renders (a toggle-shaped filter control), not for what
 * it means — `kind` (rendering) and `scope` (viewer vs. bill fact) are kept
 * orthogonal in lib/filterDimensions.ts, and a component named after scope
 * would re-couple them. A binary custom field is a bill fact rendered as a
 * toggle; My bills is a viewer fact rendered as a toggle — this component
 * serves both identically.
 */
export function FilterToggle({ label, active, onToggle, count, showCheck }: FilterToggleProps) {
  return (
    <button
      onClick={onToggle}
      aria-pressed={active}
      style={{
        fontSize: fontSize.sm,
        padding: '6px 10px',
        borderRadius: radius.md,
        cursor: 'pointer',
        whiteSpace: 'nowrap',
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        background: active ? color.bgInfo : color.white,
        color: active ? color.linkBlue : color.textSlate,
        border: `1px solid ${active ? color.tagBorderBlue : color.borderDefault}`,
        fontWeight: active ? fontWeight.medium : fontWeight.normal,
      }}
    >
      {label}{showCheck && active ? ' ✓' : ''}
      {/* Spacing comes from the button's own flex `gap: 4` alone — no
          `marginLeft` here too, which would double it to 8px (as it did for
          three of the four call sites right after this component was
          extracted; see task-7-report.md, Minor 4). */}
      {count !== undefined && <span style={COUNT_BADGE}>{count.toLocaleString()}</span>}
    </button>
  )
}
