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
  eventTypes: { typeId: number; label: string; kind?: string; explainer: string | null }[]
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

/** A state's labels, once they load. Null while loading, for no state, and when the request fails. */
export function useStateLabels(state: string | null | undefined): StateLabels | null {
  const [labels, setLabels] = useState<StateLabels | null>(null)
  useEffect(() => {
    setLabels(null)
    if (!state) return
    let live = true
    void loadStateLabels(state).then(l => { if (live) setLabels(l) })
    return () => { live = false }
  }, [state])
  return labels
}

/** The explainer for a bill's status label, from its state's labels. */
export function statusExplainer(labels: StateLabels | null, status: string | null | undefined): string | null {
  return (status && labels?.statuses?.find(s => s.label === status)?.explainer) || null
}

/** The explainer for a bill type, by the value central sends as the bill's type (compared without regard to case). */
export function billTypeExplainer(labels: StateLabels | null, billType: string | null | undefined): string | null {
  const value = billType?.trim().toLowerCase()
  return (value && labels?.billTypes?.find(t => t.value.toLowerCase() === value)?.explainer) || null
}
