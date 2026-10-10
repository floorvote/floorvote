import { PROVIDERS, type Provider } from '../providers'
import { providerEnv } from './providerContext'
import type { Env } from '../types'

/** Whether this deployment is configured to read a provider. One without `enabled` is always on. */
export function providerEnabled(provider: Provider, env: Env): boolean {
  return provider.enabled?.(providerEnv(provider, env)) ?? true
}

/**
 * States this deployment reads from a provider other than LegiScan, which the
 * LegiScan sync leaves alone. Env vars turn those providers on until state
 * ownership moves to a table (#292).
 */
export function directStates(env: Env): Set<string> {
  return new Set(PROVIDERS.filter(p => p.states && providerEnabled(p, env)).flatMap(p => p.states ?? []))
}

/** The queue a provider's bills are ingested from: its own binding, when it declares one and it is bound. */
export function ingestQueueFor(provider: Provider, env: Env): Queue {
  return (provider.ingestQueue ? env[provider.ingestQueue] as Queue | undefined : undefined) ?? env.INGESTOR_QUEUE
}
