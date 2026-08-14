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
//
// settled — GET /config has come back (or failed). Both flags above start
// `false` because that is the only answer available before the response lands,
// so on a demo tenant `demoMode === false` is ambiguous for the first render or
// two: it means either "not a demo" or "don't know yet". Hiding a Feedback
// button for an extra beat is harmless, but anything that *writes* on the
// strength of `!demoMode` — the two mention mark-read call sites — has to wait
// for this instead, or a cold load of a demo URL POSTs read_at onto the shared
// demo-user row before the gate can close.
type DemoState = {
  demoMode: boolean
  demoLocked: boolean
  settled: boolean
}

const DemoContext = createContext<DemoState>({ demoMode: false, demoLocked: false, settled: false })

export function DemoProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<DemoState>({ demoMode: false, demoLocked: false, settled: false })

  useEffect(() => {
    apiFetch<{ demoMode: boolean; demoLocked: boolean }>('/config')
      .then((r) => setState({ demoMode: r.demoMode ?? false, demoLocked: r.demoLocked ?? false, settled: true }))
      // Settle on failure too. A tenant whose /config is down is not a demo as
      // far as anything downstream can tell, and leaving `settled` false forever
      // would silently disable mark-read on every real tenant that hiccups.
      .catch(() => { setState({ demoMode: false, demoLocked: false, settled: true }) })
  }, [])

  return <DemoContext value={state}>{children}</DemoContext>
}

export function useDemo() {
  return useContext(DemoContext)
}
