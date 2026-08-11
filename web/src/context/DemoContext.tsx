import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { apiFetch } from '../lib/api'

// demoMode — this tenant is a demo at all. Used to hide things that make no
// sense to a demo visitor (the Feedback button).
//
// demoLocked — the *destructive and admin* actions are refused by the server.
// Not "every write": demo tenants allow the additive member actions (comment,
// vote, react, personal note, priority, official position, custom field
// values, single-bill triage dismiss). Those controls must NOT consult this
// flag. The authoritative split is DEMO_WRITE_ALLOWLIST in
// api/src/middleware/auth.ts; disabling a control the server allows makes the
// demo read like a screenshot, which is the regression this flag caused once.
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
