import { useId, useState } from 'react'
import { CHIP_MINI, chipOutline } from '../lib/chipStyles'
import { HoverTooltip } from './HoverTooltip'
import { color, fontSize, radius } from '../styles/tokens'

function SubjectChip({ name, onClick }: { name: string; onClick: () => void }) {
  const [hovered, setHovered] = useState(false)
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        ...CHIP_MINI,
        whiteSpace: 'nowrap',
        cursor: 'pointer',
        ...chipOutline(false, hovered, true),
      }}
    >
      {name}
    </button>
  )
}

interface SubjectsTriggerProps {
  count: number
  /** Two-letter state, shown in the tooltip so a multi-state tenant knows whose terms these are. */
  state: string
  open: boolean
  /** id of the SubjectsPanel this trigger controls, for aria-controls. */
  panelId: string
  onToggle: () => void
}

/**
 * Subjects live behind a disclosure whose trigger sits inside meta row 1, so a
 * collapsed bill costs no extra line. The panel (SubjectsPanel) renders as a
 * sibling elsewhere in the page rather than a child of that flex row, which is why
 * this is a button with aria-controls and not a <details> — <details> renders its
 * panel inside itself, and the panel has to escape the row. That's also why this
 * is two components instead of one returning a fragment: the trigger and panel
 * are mounted into different parents by the caller.
 *
 * HoverTooltip's default archetype treats `children` as an already-interactive
 * element with its own accessible name, and only adds the visual hover/focus
 * bubble (aria-hidden) — it does not wire aria-describedby itself. So the trigger
 * carries its own visually-hidden description, always present in the DOM, that
 * aria-describedby points to; the tooltip text passed to HoverTooltip is kept
 * identical so sighted hover/focus users and screen-reader users see/hear the
 * same thing.
 */
export function SubjectsTrigger({ count, state, open, panelId, onToggle }: SubjectsTriggerProps) {
  const descId = useId()
  const tooltipText = `Subject terms assigned by the legislature (${state}).`

  return (
    <HoverTooltip text={tooltipText} maxWidth={240} placement="top-start">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        aria-describedby={descId}
        onClick={onToggle}
        style={{
          font: 'inherit', fontSize: fontSize.sm, background: 'none', border: 'none',
          padding: 0, cursor: 'pointer', borderRadius: radius.xs,
          color: open ? color.textPrimary : color.linkBlue,
          display: 'inline-flex', alignItems: 'center', gap: 4,
        }}
      >
        <span aria-hidden="true" style={{
          fontSize: fontSize.xs, color: color.textMuted, display: 'inline-block',
          transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 0.12s ease',
        }}>▶</span>
        Subjects{' '}
        <span style={{ color: color.textMuted, fontVariantNumeric: 'tabular-nums' }}>
          ({count})
        </span>
        <span id={descId} style={{
          position: 'absolute', width: 1, height: 1, padding: 0, margin: -1,
          overflow: 'hidden', clip: 'rect(0, 0, 0, 0)', whiteSpace: 'nowrap', border: 0,
        }}>
          {tooltipText}
        </span>
      </button>
    </HoverTooltip>
  )
}

interface SubjectsPanelProps {
  id: string
  subjects: string[]
  open: boolean
  onSubjectClick: (name: string) => void
}

export function SubjectsPanel({ id, subjects, open, onSubjectClick }: SubjectsPanelProps) {
  // Unmounted rather than merely hidden when closed: a hidden-but-present panel
  // still matches text queries (and stays in the accessibility tree via the
  // browser's own [hidden] handling only for rendering, not for DOM presence),
  // so a truly collapsed disclosure removes its content rather than styling it away.
  if (subjects.length === 0 || !open) return null
  return (
    <div
      id={id}
      style={{
        border: `1px solid ${color.borderDefault}`,
        borderRadius: radius.md,
        padding: '7px 10px',
        marginBottom: 6,
        width: 'fit-content',
        maxWidth: '100%',
        display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center',
      }}
    >
      {subjects.map(name => (
        <SubjectChip key={name} name={name} onClick={() => onSubjectClick(name)} />
      ))}
    </div>
  )
}
