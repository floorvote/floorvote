import { DEFAULT_PROVIDER_ID, findProvider, getProvider, type Provider } from '../providers'
import { ownerOf, type StateOwners } from './stateProviders'

/**
 * What a state's data can do, from the provider that owns it. Instances gate
 * features on these, never on a state's name: a state whose provider
 * publishes the legislature's own calendar gets its body events, and one
 * whose provider sends deadlines can show them.
 */
export interface Capabilities {
  /** The provider publishes the legislature's own calendar (`Provider.listBodyEvents`). */
  bodyEvents: boolean
  /** The provider sends deadlines: a calendar event type of kind `deadline`. */
  deadlines: boolean
  /**
   * What members call the body that holds those events ("Council"), for the
   * Calendar page's "Council events" control. Present only with `bodyEvents`,
   * and only when the provider names one (`Provider.bodyName`).
   */
  bodyName?: string
}

export function providerCapabilities(provider: Provider): Capabilities {
  return {
    bodyEvents: !!provider.listBodyEvents,
    deadlines: Object.values(provider.vocabulary.eventTypes).some(t => t.kind === 'deadline'),
    ...(provider.listBodyEvents && provider.bodyName ? { bodyName: provider.bodyName } : {}),
  }
}

/** A state's capabilities, from its owner in `owners`. */
export function stateCapabilities(owners: StateOwners, state: string): Capabilities {
  return providerCapabilities(findProvider(ownerOf(owners, state)) ?? getProvider(DEFAULT_PROVIDER_ID))
}

/**
 * The capabilities of each state a coverage list names that has any, by
 * state. `*` covers every state, and lists each state with an ownership row
 * whose provider has one. A state left out has none. A state named without a
 * row has the default provider's, which sends deadlines.
 */
export function coverageCapabilities(owners: StateOwners, coverage: readonly string[]): Record<string, Capabilities> {
  const states = coverage.includes('*') ? [...owners.keys()] : coverage
  const out: Record<string, Capabilities> = {}
  for (const state of [...new Set(states)].sort()) {
    const caps = stateCapabilities(owners, state)
    if (caps.bodyEvents || caps.deadlines) out[state] = caps
  }
  return out
}
