import { Link } from 'react-router-dom'
import { color, fontSize, radius } from '../styles/tokens'
import { PRODUCT_NAME } from '../../../shared/brand'
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
      {/* xxl, not base: at 14px the lockup read as subordinate to the 22px-wide
          hamburger beside it. The whole lockup scales from `size` (mark height and
          mark→name gap are em-based), and the bar is 48px tall, so there's headroom.
          The link is here rather than inside Wordmark — the login pages share that
          component and must not link into an authed route. */}
      <Link
        to="/"
        aria-label={`${PRODUCT_NAME} home`}
        style={{ display: 'inline-flex', alignItems: 'center', textDecoration: 'none', minWidth: 0 }}
      >
        <Wordmark dark size={fontSize.xxl} />
      </Link>
    </div>
  )
}
