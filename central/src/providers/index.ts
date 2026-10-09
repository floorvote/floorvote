/**
 * The provider registry: the one place core reaches a provider. Core asks for a
 * provider by id and talks to it through the interface in ./types, which this
 * module re-exports. ESLint keeps core from importing a provider any other way.
 */
import { legiscan } from './legiscan'
import type { Provider } from './types'

export type * from './types'

/** Every provider central knows. */
const PROVIDERS: readonly Provider[] = [legiscan]

/** The provider central uses wherever nothing names another. */
export const DEFAULT_PROVIDER_ID = 'legiscan'

/** The provider with this id. Throws for an id central doesn't know. */
export function getProvider(id: string): Provider {
  const provider = PROVIDERS.find(p => p.id === id)
  if (!provider) throw new Error(`unknown provider: ${id}`)
  return provider
}
