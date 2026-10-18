import { useConfig } from '../context/ConfigContext'

/**
 * Whether any covered state's provider publishes the legislature's own
 * calendar (`capabilities` in GET /config). Features gate on capabilities,
 * never on a state's name.
 */
/**
 * Whether the Stage filter is worth offering: some covered state's provider
 * is not LegiScan. LegiScan's status field almost never carries the
 * in-committee codes, so "In committee" would always be empty there. An
 * instance that has not heard from central yet shows it (no flash of a
 * missing filter on a provider that does fill it in).
 */
export function useStageFilterUseful(): boolean {
  const { config } = useConfig()
  // /config names no provider per state, but `attribution.providers` lists exactly the providers that own a covered state.
  // It is absent until central has named them, which is not yet knowing the states are LegiScan's.
  if (!config?.attribution) return true
  return config.attribution.providers.some(p => p.id !== 'legiscan')
}

export function useHasBodyEvents(): boolean {
  const { config } = useConfig()
  return Object.values(config?.capabilities ?? {}).some(c => c.bodyEvents)
}

/**
 * What members call the body whose calendar the instance shows ("Council"),
 * from the provider that publishes it, for the Calendar page's "Council
 * events" control. "Legislature" when no covered state's provider names one,
 * or when the covered states' providers name different ones.
 */
export function useBodyEventsName(): string {
  const { config } = useConfig()
  const names = new Set(Object.values(config?.capabilities ?? {}).filter(c => c.bodyEvents).map(c => c.bodyName?.trim() || ''))
  const [only] = names.size === 1 ? names : []
  return only || 'Legislature'
}
