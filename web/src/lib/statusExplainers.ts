import { useEffect, useState } from 'react'
import { apiFetch } from './api'

/**
 * A state's explainers and display details, from GET /bills/labels. Central
 * keeps one vocabulary per provider and serves the one for the provider that
 * owns the state, so a DC bill read from the Council's LIMS gets DC's own
 * status names explained.
 */
export interface StateLabels {
  statuses: { label: string; stage: string | null; rank: number; explainer: string }[]
  billTypes: { value: string; label: string; explainer: string | null }[]
  eventTypes: { typeId: number; label: string; explainer: string | null }[]
  calendarName: string | null
  hasEvents: boolean
}

// One request per state per page load: vocabularies change only when central
// is deployed. A failed request isn't kept, so the next bill page tries again.
const cache = new Map<string, Promise<StateLabels | null>>()

export function loadStateLabels(state: string): Promise<StateLabels | null> {
  let labels = cache.get(state)
  if (!labels) {
    labels = apiFetch<StateLabels>(`/bills/labels?state=${encodeURIComponent(state)}`).catch(() => {
      cache.delete(state)
      return null
    })
    cache.set(state, labels)
  }
  return labels
}

/**
 * The plain-language explainer for a bill's status label in its state, once
 * the state's labels load. Null while loading, and for a status with no
 * explainer.
 */
export function useStatusExplainer(state: string | null | undefined, status: string | null | undefined): string | null {
  const [explainer, setExplainer] = useState<string | null>(null)
  useEffect(() => {
    setExplainer(null)
    if (!state || !status) return
    let live = true
    void loadStateLabels(state).then(labels => {
      if (live) setExplainer(labels?.statuses?.find(s => s.label === status)?.explainer ?? null)
    })
    return () => { live = false }
  }, [state, status])
  return explainer
}
