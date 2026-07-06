import { useState, useEffect, useRef } from 'react'
import { useNavigation, useLocation } from 'react-router-dom'

// Ambient top progress bar for in-app navigation. The `nav-pending` wait cursor
// is invisible on touch, so this gives feedback while the data router runs the
// destination route's loader. It reads the router's navigation state directly
// (`useNavigation().state !== 'idle'`) and runs a 4-phase cycle: grow toward 90%
// while loading → snap to 100% → hold → fade out. (Pure CSS can't animate "to
// 100% on completion" when keyed on the state going idle, hence the small state
// machine here.) Styling (color, glow, height, position) lives in mobile.css
// under `.nav-progress`.
type NavPhase = 'idle' | 'active' | 'done' | 'fade'

export function NavProgressBar() {
  const navigation = useNavigation()
  const location = useLocation()
  // Same-route param changes (search, filter, sort) are handled by each page's
  // own loading indicator — only show the bar for actual page navigations.
  const sameRoute = navigation.location?.pathname === location.pathname
  const pending = navigation.state !== 'idle' && !sameRoute
  const [phase, setPhase] = useState<NavPhase>('idle')
  const phaseRef = useRef(phase)
  phaseRef.current = phase

  useEffect(() => {
    if (pending) {
      if (phaseRef.current !== 'active') setPhase('active')
    } else if (phaseRef.current === 'active') {
      setPhase('done')
    }
  }, [pending])

  useEffect(() => {
    if (phase === 'done') {
      const t = setTimeout(() => setPhase('fade'), 250)
      return () => clearTimeout(t)
    }
    if (phase === 'fade') {
      const t = setTimeout(() => setPhase('idle'), 450)
      return () => clearTimeout(t)
    }
  }, [phase])

  const transform = phase === 'active' ? 'scaleX(0.9)' : phase === 'done' || phase === 'fade' ? 'scaleX(1)' : 'scaleX(0)'
  const opacity = phase === 'idle' || phase === 'fade' ? 0 : 1
  const transition =
    phase === 'active' ? 'transform 8s cubic-bezier(0.05, 0.7, 0.1, 1)'
      : phase === 'done' ? 'transform 0.2s ease-out'
        : phase === 'fade' ? 'opacity 0.45s ease'
          : 'none'

  return <div className="nav-progress" aria-hidden="true" style={{ transform, opacity, transition }} />
}
