import { useEffect } from 'react'
import { useNavigation } from 'react-router-dom'

/**
 * Toggle the `body.nav-pending` wait-cursor class from the data router's
 * navigation state. While a route's loader is running (`state !== 'idle'`) the
 * current page is held in place and the cursor shows `wait` (see the rule in
 * mobile.css). This replaces the manual class toggling the old useDeferredNavigate
 * hook did — the cursor-and-wait behavior now falls out of the router itself.
 * Mount once inside the data router (AppLayout).
 */
export function useNavPendingCursor(): void {
  const pending = useNavigation().state !== 'idle'
  useEffect(() => {
    if (pending) document.body.classList.add('nav-pending')
    else document.body.classList.remove('nav-pending')
    return () => document.body.classList.remove('nav-pending')
  }, [pending])
}
