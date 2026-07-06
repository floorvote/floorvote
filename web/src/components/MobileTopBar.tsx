import { color, fontSize, radius } from '../styles/tokens'
import { Wordmark } from './Wordmark'

interface MobileTopBarProps {
  onHamburgerClick: () => void
}

export function MobileTopBar({ onHamburgerClick }: MobileTopBarProps) {
  return (
    <div className="mobile-topbar">
      <button
        onClick={onHamburgerClick}
        style={{
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          color: color.white,
          padding: '4px 6px',
          display: 'flex',
          flexDirection: 'column',
          gap: 5,
          flexShrink: 0,
        }}
        aria-label="Open menu"
      >
        <span style={{ display: 'block', width: 22, height: 2, background: color.white, borderRadius: radius.xs }} />
        <span style={{ display: 'block', width: 22, height: 2, background: color.white, borderRadius: radius.xs }} />
        <span style={{ display: 'block', width: 22, height: 2, background: color.white, borderRadius: radius.xs }} />
      </button>
      <Wordmark dark size={fontSize.base} />
    </div>
  )
}
