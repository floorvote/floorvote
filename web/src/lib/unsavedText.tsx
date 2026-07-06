import { createContext, useContext, useEffect, useRef, type ReactNode } from 'react'
import { useBlocker } from 'react-router-dom'

export interface UnsavedEntry {
  /** True when the field holds text that would be lost on navigation. */
  isDirty: () => boolean
  /** Bring the field back to a clean state (clear / cancel / flush-save). */
  reset: () => void
}

export interface UnsavedTextRegistry {
  register: (entry: UnsavedEntry) => () => void
  hasUnsaved: () => boolean
  resetAll: () => void
}

export function createUnsavedRegistry(): UnsavedTextRegistry {
  const entries = new Set<UnsavedEntry>()
  return {
    register(entry) {
      entries.add(entry)
      return () => { entries.delete(entry) }
    },
    hasUnsaved() {
      for (const e of entries) if (e.isDirty()) return true
      return false
    },
    resetAll() {
      for (const e of entries) if (e.isDirty()) e.reset()
    },
  }
}

// Only `register` is exposed to children; the page owns hasUnsaved/resetAll.
export const UnsavedTextContext = createContext<Pick<UnsavedTextRegistry, 'register'> | null>(null)

/**
 * Register an editable field with the surrounding UnsavedTextContext, if any.
 * The latest isDirty/reset closures are always used (kept in a ref), so callers
 * don't need to memoize them.
 */
export function useUnsavedRegistration(entry: UnsavedEntry): void {
  const reg = useContext(UnsavedTextContext)
  const ref = useRef(entry)
  ref.current = entry
  useEffect(() => {
    if (!reg) return
    return reg.register({
      isDirty: () => ref.current.isDirty(),
      reset: () => ref.current.reset(),
    })
  }, [reg])
}

/**
 * Blocks in-app navigation (incl. browser back/forward, which a bare confirm in a
 * click handler can't catch) and full-page unloads (tab close / reload) whenever
 * any registered field is dirty. Requires a data router (`useBlocker`), so it must
 * be rendered inside `RouterProvider` — i.e. within a route element like AppLayout.
 */
function UnsavedNavGuard({ registry }: { registry: UnsavedTextRegistry }) {
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      registry.hasUnsaved() && currentLocation.pathname !== nextLocation.pathname,
  )
  useEffect(() => {
    if (blocker.state !== 'blocked') return
    if (window.confirm('You have unsaved text on this page. If you leave, it will be discarded. Continue?')) {
      registry.resetAll()
      blocker.proceed()
    } else {
      blocker.reset()
    }
  }, [blocker, registry])
  useEffect(() => {
    function onBeforeUnload(e: BeforeUnloadEvent) {
      if (registry.hasUnsaved()) {
        e.preventDefault()
        e.returnValue = ''
      }
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [registry])
  return null
}

/**
 * App-level owner of a single unsaved-text registry. Provides `register` to
 * descendant editors (via UnsavedTextContext) and mounts the navigation guard.
 * Mount once, inside the router (AppLayout) so every page's editors share one
 * registry and a single guard covers all navigation.
 */
export function UnsavedTextProvider({ children }: { children: ReactNode }) {
  const ref = useRef<UnsavedTextRegistry | null>(null)
  if (!ref.current) ref.current = createUnsavedRegistry()
  return (
    <UnsavedTextContext value={ref.current}>
      <UnsavedNavGuard registry={ref.current} />
      {children}
    </UnsavedTextContext>
  )
}
