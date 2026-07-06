import { useEffect, useRef, useState, type DependencyList } from 'react'

/**
 * Reports whether a scroll container is scrolled away from the top.
 * Used to show a header's pinned shadow only once content has scrolled under it.
 *
 * @param getScroller resolves the scroll container (e.g. `() => listRef.current`
 *   or `() => document.querySelector('main')`).
 * @param deps re-resolve/re-bind when these change. Default `[]` (resolve once on
 *   mount) — pass e.g. a "list is now shown" flag when the scroll container is
 *   rendered conditionally and so appears after mount.
 */
export function useScrolledUnder(
  getScroller: () => Element | null | undefined,
  deps: DependencyList = [],
): boolean {
  const [scrolled, setScrolled] = useState(false)
  // Hold the latest getter in a ref so the effect can re-resolve without listing
  // the getter (a fresh closure each render) as a dependency.
  const getRef = useRef(getScroller)
  getRef.current = getScroller

  useEffect(() => {
    const scroller = getRef.current()
    if (!scroller) return
    const onScroll = () => setScrolled(scroller.scrollTop > 0)
    onScroll()
    scroller.addEventListener('scroll', onScroll, { passive: true })
    return () => scroller.removeEventListener('scroll', onScroll)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)

  return scrolled
}
