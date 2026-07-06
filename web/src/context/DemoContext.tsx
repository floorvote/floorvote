import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { apiFetch } from '../lib/api'

type DemoState = {
  demoMode: boolean
  demoLocked: boolean
}

const DemoContext = createContext<DemoState>({ demoMode: false, demoLocked: false })

export function DemoProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<DemoState>({ demoMode: false, demoLocked: false })

  useEffect(() => {
    apiFetch<{ demoMode: boolean; demoLocked: boolean }>('/config')
      .then((r) => setState({ demoMode: r.demoMode ?? false, demoLocked: r.demoLocked ?? false }))
      .catch(() => {})
  }, [])

  return <DemoContext value={state}>{children}</DemoContext>
}

export function useDemo() {
  return useContext(DemoContext)
}
