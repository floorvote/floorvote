import { useRef, useState } from 'react'
import { color, radius, fontSize, shadow } from '../../styles/tokens'
import { voteButtonStyle } from '../../lib/voteButtonStyle'

export function VoteButton({ label, pos, current, onClick }: {
  label: string
  pos: 'support' | 'neutral' | 'oppose'
  current: string | null
  onClick: () => void
}) {
  const [tooltip, setTooltip] = useState<{ x: number; y: number } | null>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const isActive = current === pos
  const tooltipText = isActive
    ? `You voted ${label.toLowerCase()} — click to remove your vote`
    : `Vote ${label.toLowerCase()} on this bill`

  function handleMouseEnter() {
    if (btnRef.current) {
      const r = btnRef.current.getBoundingClientRect()
      setTooltip({ x: r.left + r.width / 2, y: r.top })
    }
  }

  return (
    <div style={{ flex: '1 1 0', minWidth: 0 }}>
      <button
        ref={btnRef}
        onClick={onClick}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={() => setTooltip(null)}
        style={{
          width: '100%', fontSize: fontSize.sm, padding: '3px 4px',
          ...voteButtonStyle(pos, isActive, !!tooltip),
        }}
      >
        {label}
      </button>
      {tooltip && (
        <span style={{
          position: 'fixed',
          // Center on button but clamp left edge to 8px so it doesn't fall off screen
          left: Math.max(8, Math.min(window.innerWidth - 228, tooltip.x - 110)),
          top: tooltip.y,
          transform: 'translateY(calc(-100% - 6px))',
          background: color.white, border: `1px solid ${color.borderDefault}`, boxShadow: shadow.md,
          color: color.textSlate500, padding: '4px 8px', borderRadius: radius.sm, fontSize: fontSize.sm,
          whiteSpace: 'nowrap', zIndex: 9999, pointerEvents: 'none',
        }}>
          {tooltipText}
        </span>
      )}
    </div>
  )
}
