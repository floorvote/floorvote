import { createContext, useCallback, useContext, useEffect, useRef, type ReactNode } from 'react'

// Stores a mutable ref to the sidebar's refresh function.
// Using a ref (not state) avoids re-renders when the callback is registered.
const SidebarRefreshContext = createContext<React.MutableRefObject<() => void>>({ current: () => {} })

export function SidebarRefreshProvider({ children }: { children: ReactNode }) {
  const callbackRef = useRef<() => void>(() => {})
  return (
    <SidebarRefreshContext value={callbackRef}>
      {children}
    </SidebarRefreshContext>
  )
}

/** Called by Sidebar to register its forceRefresh function. */
export function useRegisterSidebarRefresh(fn: () => void) {
  const ref = useContext(SidebarRefreshContext)
  useEffect(() => { ref.current = fn }, [fn, ref])
}

/** Called by any descendant to trigger an immediate sidebar re-fetch. */
export function useSidebarRefresh(): () => void {
  const ref = useContext(SidebarRefreshContext)
  return useCallback(() => ref.current(), [ref])
}
